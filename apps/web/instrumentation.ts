export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startTracing } = await import('@commerce/telemetry');
    startTracing({ serviceName: 'web', instrument: false });
  }
}
