import type { SpecialistFinding } from './types.js';

export interface ModelInfo {
  readonly id: string;
  readonly model: string;
  readonly promptVersion: string;
  /** simulated: no real model; every report built on it is SIMULATED. */
  readonly mode: 'simulated' | 'real';
}

export interface Synthesis {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * The language-model seam of the specialists: turn structured, already-authorized findings into
 * an answer. It never sees credentials, never chooses tools and never decides an effect.
 */
export interface Synthesizer {
  readonly info: ModelInfo;
  estimateTokens(findings: readonly SpecialistFinding[]): number;
  synthesize(findings: readonly SpecialistFinding[]): Promise<Synthesis>;
}

const approxTokens = (text: string) => Math.ceil(text.length / 4);

/**
 * Deterministic template synthesizer used instead of a paid model (project constraint: no AI keys
 * or paid calls). It labels facts, inferences, uncertainty and next steps exactly as found. Token
 * counts are estimates (characters / 4) and are reported as SIMULATED, never as provider usage.
 */
export class TemplateSynthesizer implements Synthesizer {
  readonly info: ModelInfo = {
    id: 'template-synth',
    model: 'template-synth.v1',
    promptVersion: 'synth.v1',
    mode: 'simulated',
  };

  estimateTokens(findings: readonly SpecialistFinding[]): number {
    const input = approxTokens(JSON.stringify(findings));
    return input + Math.ceil(input / 2);
  }

  synthesize(findings: readonly SpecialistFinding[]): Promise<Synthesis> {
    const sections: string[] = [];
    for (const f of findings) {
      const lines: string[] = [];
      for (const fact of f.facts) lines.push(`- Hecho: ${fact.text} [${fact.evidence.ref}]`);
      for (const inference of f.inferences)
        lines.push(
          `- ${inference.startsWith('Inferencia') ? inference : `Inferencia: ${inference}`}`,
        );
      for (const u of f.uncertainty) lines.push(`- Incertidumbre: ${u}`);
      if (f.escalation?.required) {
        lines.push(
          `- Escalamiento requerido (${f.escalation.ruleVersion}): ${f.escalation.reasons.join(', ')}`,
        );
      }
      for (const step of f.nextSteps) lines.push(`- Siguiente paso: ${step}`);
      sections.push(`${TITLES[f.specialist]}\n${lines.join('\n') || '- Sin datos disponibles.'}`);
    }
    const text = sections.join('\n\n');
    return Promise.resolve({
      text,
      inputTokens: approxTokens(JSON.stringify(findings)),
      outputTokens: approxTokens(text),
    });
  }
}

const TITLES = {
  order: 'Investigación de la orden',
  recommendation: 'Recomendación de productos',
  inventory: 'Alertas de inventario',
} as const;
