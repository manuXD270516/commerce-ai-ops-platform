// Local Kubernetes validation of infra/k8s (overlays/local) on a throwaway k3s cluster that runs as
// one Docker container named commerce-ai-ops-k3s; nothing else on the machine is touched.
//   1. start k3s, import the app images built by `pnpm prod:up` (tag IMAGE_TAG, default local)
//   2. create the Secrets from .local/prod and a throwaway local CA (never written to the repo)
//   3. apply in order: platform + data, migration job (wait), apps (wait for rollout)
//   4. run infra/scripts/demo.mjs through the Traefik ingress over TLS
//   5. rollout check: a broken api image never becomes ready, the old pods keep serving and
//      `kubectl rollout undo` restores it; then the migration job re-run keeps the data
//   6. delete the cluster (unless --keep)
// Usage: pnpm k8s:local [--keep]   Requires Docker, pnpm build and pnpm prod:secrets.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createChecks, root, waitUntil, writeRunReport } from './prod-lib.mjs';

const NAME = 'commerce-ai-ops-k3s';
const K3S_IMAGE = 'rancher/k3s:v1.33.1-k3s1';
const PORT = process.env.K8S_HTTPS_PORT ?? '9443';
const TAG = process.env.IMAGE_TAG ?? 'local';
const keep = process.argv.includes('--keep');
const secretsDir = join(root, '.local', 'prod');
const pkiDir = join(root, '.local', 'k8s');
const startedAt = new Date();
const { checks, check } = createChecks();
const timings = {};
const APPS = ['api', 'worker', 'mcp', 'web', 'migrate'];

const docker = (args, options = {}) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options });
const kubectl = (args, options = {}) => docker(['exec', '-i', NAME, 'kubectl', ...args], options);
const kustomizeApply = (selector) =>
  docker([
    'exec',
    '-i',
    NAME,
    'sh',
    '-c',
    `kubectl kustomize /k8s/overlays/local | kubectl apply -l ${selector} -f -`,
  ]);

function openssl(args) {
  const candidates = ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe'];
  for (const bin of candidates) {
    const r = spawnSync(bin, args, { encoding: 'utf8' });
    if (r.status === 0) return r.stdout;
    if (r.error?.code !== 'ENOENT') throw new Error(`openssl ${args[0]} failed: ${r.stderr}`);
  }
  throw new Error('openssl not found');
}

/** Throwaway CA + localhost certificate for the ingress; the demo trusts only this CA. */
function localPki() {
  mkdirSync(pkiDir, { recursive: true });
  const f = (n) => join(pkiDir, n);
  openssl([
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=commerce-ai-ops local test CA',
    '-keyout',
    f('ca.key'),
    '-out',
    f('ca.crt'),
  ]);
  openssl([
    'req',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-subj',
    '/CN=localhost',
    '-keyout',
    f('tls.key'),
    '-out',
    f('tls.csr'),
  ]);
  const ext = f('san.ext');
  execFileSync(process.execPath, [
    '-e',
    `require('fs').writeFileSync(${JSON.stringify(ext)}, 'subjectAltName=DNS:localhost\\nextendedKeyUsage=serverAuth\\n')`,
  ]);
  openssl([
    'x509',
    '-req',
    '-in',
    f('tls.csr'),
    '-CA',
    f('ca.crt'),
    '-CAkey',
    f('ca.key'),
    '-CAcreateserial',
    '-days',
    '2',
    '-extfile',
    ext,
    '-out',
    f('tls.crt'),
  ]);
  return { ca: f('ca.crt'), crt: f('tls.crt'), key: f('tls.key') };
}

function secretYaml(name, type, files) {
  const data = Object.entries(files)
    .map(([key, path]) => `  ${key}: ${readFileSync(path).toString('base64')}`)
    .join('\n');
  return `apiVersion: v1\nkind: Secret\nmetadata:\n  name: ${name}\n  namespace: commerce\ntype: ${type}\ndata:\n${data}\n`;
}

function rolledOut(kind, name, timeout = '240s') {
  try {
    kubectl(['-n', 'commerce', 'rollout', 'status', `${kind}/${name}`, `--timeout=${timeout}`]);
    return true;
  } catch {
    return false;
  }
}

function cleanup() {
  if (keep) {
    console.log(`cluster kept: docker exec -it ${NAME} kubectl -n commerce get pods`);
    return;
  }
  spawnSync('docker', ['rm', '-f', '-v', NAME], { stdio: 'ignore' });
  console.log(`cluster ${NAME} deleted`);
}

if (!existsSync(join(secretsDir, 'jwks.json'))) {
  console.error('run pnpm prod:secrets first');
  process.exit(1);
}
// The script itself calls the ingress, so it must trust the throwaway CA too: create it first and
// re-run with NODE_EXTRA_CA_CERTS (never NODE_TLS_REJECT_UNAUTHORIZED=0).
if (process.env.NODE_EXTRA_CA_CERTS !== join(pkiDir, 'ca.crt')) {
  localPki();
  const child = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, NODE_EXTRA_CA_CERTS: join(pkiDir, 'ca.crt') },
  });
  process.exit(child.status ?? 1);
}
const pki = {
  ca: join(pkiDir, 'ca.crt'),
  crt: join(pkiDir, 'tls.crt'),
  key: join(pkiDir, 'tls.key'),
};

try {
  // 1. cluster
  const t0 = performance.now();
  spawnSync('docker', ['rm', '-f', '-v', NAME], { stdio: 'ignore' });
  docker([
    'run',
    '-d',
    '--name',
    NAME,
    '--privileged',
    '--tmpfs',
    '/run',
    '--tmpfs',
    '/var/run',
    '-p',
    `127.0.0.1:${PORT}:443`,
    '-v',
    `${join(root, 'infra', 'k8s')}:/k8s:ro`,
    K3S_IMAGE,
    'server',
  ]);
  const nodeReady = await waitUntil(
    async () => kubectl(['get', 'nodes', '--no-headers']).includes(' Ready'),
    180_000,
    2000,
  );
  check('k3s cluster ready', nodeReady, K3S_IMAGE);
  timings.k8s_cluster_ready_ms = performance.now() - t0;

  // k3s' service load balancer binds Traefik to the container's port 443, published on PORT.
  const t1 = performance.now();
  const images = APPS.map((a) => `commerce-ai-ops/${a}:${TAG}`);
  const tar = execFileSync('docker', ['save', ...images], { maxBuffer: 8 * 1024 ** 3 });
  docker(['exec', '-i', NAME, 'ctr', 'images', 'import', '-'], {
    input: tar,
    maxBuffer: 64 * 1024 ** 2,
  });
  timings.k8s_image_import_ms = performance.now() - t1;
  check('app images imported into the cluster', true, `${Math.round(tar.length / 1024 ** 2)} MiB`);

  // 2. secrets
  kustomizeApply('app.kubernetes.io/component=platform');
  const s = (n) => join(secretsDir, n);
  kubectl(['apply', '-f', '-'], {
    input: secretYaml('commerce-app-secrets', 'Opaque', {
      database_url: s('database_url'),
      database_admin_url: s('database_admin_url'),
      database_migrator_url: s('database_migrator_url'),
      redis_url: s('redis_url'),
      pii_key: s('pii_key'),
      'jwks.json': s('jwks.json'),
      'issuer-private.jwk.json': s('issuer-private.jwk.json'),
      postgres_password: s('postgres_password'),
      redis_password: s('redis_password'),
    }),
  });
  kubectl(['apply', '-f', '-'], {
    input: secretYaml('edge-tls', 'kubernetes.io/tls', { 'tls.crt': pki.crt, 'tls.key': pki.key }),
  });
  // 3. data, migration, apps
  const t2 = performance.now();
  kustomizeApply('app.kubernetes.io/component=data');
  check(
    'postgres and redis ready',
    rolledOut('statefulset', 'postgres') && rolledOut('deployment', 'redis'),
  );
  kustomizeApply('app.kubernetes.io/component=migrate');
  let migrated = false;
  try {
    kubectl([
      '-n',
      'commerce',
      'wait',
      '--for=condition=complete',
      'job/migrate',
      '--timeout=300s',
    ]);
    migrated = true;
  } catch {
    // reported below
  }
  check(
    'migration job completes (migrate + seed --if-empty)',
    migrated,
    kubectl(['-n', 'commerce', 'logs', 'job/migrate']).trim().split('\n').at(-1),
  );
  kustomizeApply('app.kubernetes.io/component=app');
  const apps = ['api', 'worker', 'mcp', 'web'].map((d) => rolledOut('deployment', d));
  timings.k8s_deploy_to_ready_ms = performance.now() - t2;
  check(
    'api, worker, mcp and web roll out with passing probes',
    apps.every(Boolean),
    apps.join(' '),
  );
  const traefik = await waitUntil(
    async () => {
      const res = await fetch(`https://localhost:${PORT}/healthz`, {
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
      return res?.status === 200;
    },
    180_000,
    2000,
  );
  check('ingress serves the api over TLS', traefik, `https://localhost:${PORT}`);

  // Network policy: the console has no route to the database.
  const webPod = kubectl([
    '-n',
    'commerce',
    'get',
    'pods',
    '-l',
    'app.kubernetes.io/name=web',
    '-o',
    'jsonpath={.items[0].metadata.name}',
  ]);
  const apiPod = kubectl([
    '-n',
    'commerce',
    'get',
    'pods',
    '-l',
    'app.kubernetes.io/name=api',
    '-o',
    'jsonpath={.items[0].metadata.name}',
  ]);
  const probe = (pod) =>
    spawnSync(
      'docker',
      [
        'exec',
        NAME,
        'kubectl',
        '-n',
        'commerce',
        'exec',
        pod,
        '--',
        'node',
        '-e',
        "const s=require('net').connect(5432,'postgres');s.setTimeout(3000);s.on('connect',()=>{console.log('open');process.exit(0)});s.on('timeout',()=>{console.log('blocked');process.exit(0)});s.on('error',e=>{console.log('error '+e.code);process.exit(0)})",
      ],
      { encoding: 'utf8' },
    ).stdout.trim();
  const fromWeb = probe(webPod);
  const fromApi = probe(apiPod);
  check(
    'network policy: web cannot reach postgres, api can',
    fromWeb !== 'open' && fromApi === 'open',
    `web=${fromWeb} api=${fromApi}`,
  );

  // 4. demo through the ingress
  const demo = spawnSync(process.execPath, [join(root, 'infra', 'scripts', 'demo.mjs')], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DEMO_BASE_URL: `https://localhost:${PORT}`,
      NODE_EXTRA_CA_CERTS: pki.ca,
      K8S_CONTAINER: NAME,
    },
  });
  check('prod demo checks pass against the cluster (see m11-demo-k8s report)', demo.status === 0);

  // 5. rollout safety and migration re-run
  const runsBefore = kubectl([
    '-n',
    'commerce',
    'exec',
    'postgres-0',
    '--',
    'psql',
    '-U',
    'commerce_admin',
    '-d',
    'commerce',
    '-tAc',
    'SELECT count(*) FROM commerce.agent_runs',
  ]).trim();
  const broken = execFileSync(
    'docker',
    ['build', '-q', '-t', 'commerce-ai-ops/api:drill-broken', '-'],
    {
      input: `FROM commerce-ai-ops/api:${TAG}\nCMD ["node", "-e", "console.error('drill: broken release'); process.exit(1)"]\n`,
    },
  );
  void broken;
  docker(['exec', '-i', NAME, 'ctr', 'images', 'import', '-'], {
    input: execFileSync('docker', ['save', 'commerce-ai-ops/api:drill-broken'], {
      maxBuffer: 8 * 1024 ** 3,
    }),
    maxBuffer: 64 * 1024 ** 2,
  });
  kubectl([
    '-n',
    'commerce',
    'set',
    'image',
    'deployment/api',
    'api=commerce-ai-ops/api:drill-broken',
  ]);
  const stuck = !rolledOut('deployment', 'api', '45s');
  const served =
    (
      await fetch(`https://localhost:${PORT}/v1/products`, {
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined)
    )?.status === 401;
  check('bad release never becomes ready; previous pods keep serving', stuck && served);
  const t3 = performance.now();
  kubectl(['-n', 'commerce', 'rollout', 'undo', 'deployment/api']);
  const undone = rolledOut('deployment', 'api', '120s');
  timings.k8s_rollout_undo_ms = performance.now() - t3;
  const image = kubectl([
    '-n',
    'commerce',
    'get',
    'deployment/api',
    '-o',
    'jsonpath={.spec.template.spec.containers[0].image}',
  ]);
  check(
    'kubectl rollout undo restores the previous image',
    undone && image === `commerce-ai-ops/api:${TAG}`,
    image,
  );
  spawnSync('docker', ['image', 'rm', 'commerce-ai-ops/api:drill-broken'], { stdio: 'ignore' });

  kubectl(['-n', 'commerce', 'delete', 'job', 'migrate', '--wait=true']);
  kustomizeApply('app.kubernetes.io/component=migrate');
  kubectl(['-n', 'commerce', 'wait', '--for=condition=complete', 'job/migrate', '--timeout=300s']);
  const rerun = kubectl(['-n', 'commerce', 'logs', 'job/migrate']).trim().split('\n').at(-1);
  const runsAfter = kubectl([
    '-n',
    'commerce',
    'exec',
    'postgres-0',
    '--',
    'psql',
    '-U',
    'commerce_admin',
    '-d',
    'commerce',
    '-tAc',
    'SELECT count(*) FROM commerce.agent_runs',
  ]).trim();
  check(
    're-running the migration job keeps existing data',
    rerun.includes('"seeded":false') && runsAfter === runsBefore && Number(runsAfter) > 0,
    `${rerun}; agent_runs ${runsBefore} -> ${runsAfter}`,
  );
} catch (error) {
  check(
    'k8s validation completed',
    false,
    error instanceof Error ? error.message.split('\n')[0] : String(error),
  );
} finally {
  cleanup();
}

const path = await writeRunReport({
  suite: 'm11-k8s-local',
  description: `infra/k8s/overlays/local on ${K3S_IMAGE} in Docker; images IMAGE_TAG=${TAG}`,
  startedAt,
  checks,
  timings,
  source: 'infra/scripts/k8s-local.mjs',
});
console.log(`\nReport: ${path}`);
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
