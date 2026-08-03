import type { Difference } from 'microdiff';
import type { ClassifiedChange, Severity } from './classify.js';
import { colorEnabled, dim, green } from './color.js';
import type { ConsumedRoute } from './config.js';
import type { ExplainResult } from './explain.js';
import type { Finding } from './verify.js';

const GROUPS: Severity[] = ['breaking', 'relevant', 'ignore'];

const SYMBOL = { added: '+', removed: '-', modified: '~' } as const;

const CODES: Record<Severity, string> = {
  breaking: '\x1b[31m', // red
  relevant: '\x1b[33m', // yellow
  ignore: '\x1b[2m', // dim
};

function paint(text: string, severity: Severity): string {
  return colorEnabled() ? `${CODES[severity]}${text}\x1b[0m` : text;
}

// ponytail: values are truncated so a whole nested schema can't flood one line.
function show(value: unknown): string {
  const json = JSON.stringify(value) ?? String(value);
  return json.length > 80 ? `${json.slice(0, 79)}…` : json;
}

/** The deliberately-raw detail line under a reason — structural paths belong here, not in reasons. */
function formatRawChange(change: Difference): string {
  const at = change.path.join('.');
  if (change.type === 'CREATE') return `CREATE ${at} = ${show(change.value)}`;
  if (change.type === 'REMOVE') return `REMOVE ${at} (was ${show(change.oldValue)})`;
  return `CHANGE ${at}: ${show(change.oldValue)} → ${show(change.value)}`;
}

const heading = (change: ClassifiedChange) =>
  `${SYMBOL[change.kind]} ${change.kind.toUpperCase()} ${change.method} ${change.path}`;

/**
 * `verify`'s report. One line per finding — there is no raw diff entry behind any of them, because
 * nothing was diffed: each is a disagreement with the spec as it stands.
 *
 * The coverage note is not decoration. "Everything agrees" reads as a clean bill of health, and a
 * config with no `responseFields` checked no response field at all — saying so is the difference
 * between a green run and a green run that means something.
 */
export function printFindings(findings: Finding[], consumes: ConsumedRoute[]): void {
  const of = (severity: Severity) => findings.filter((f) => f.severity === severity);
  const scoped = consumes.filter((route) => route.responseFields?.length).length;

  if (findings.length === 0) {
    console.log(green(`All ${consumes.length} consumed route(s) agree with the spec.`));
  } else {
    console.log(
      `Verified ${consumes.length} consumed route(s) — ${of('breaking').length} breaking, ` +
        `${of('relevant').length} relevant:`,
    );
    for (const severity of GROUPS) {
      const group = of(severity);
      if (group.length === 0) continue;
      console.log(`\n${paint(`${severity.toUpperCase()} (${group.length})`, severity)}`);
      for (const finding of group) {
        console.log(`  ${paint(`${finding.method} ${finding.path}`, severity)} — ${finding.reason}`);
      }
    }
  }

  console.log(
    dim(
      scoped === 0
        ? `\nNo route declares responseFields, so no response field was checked — only route existence and headers. Re-run init to populate them.`
        : `\n${scoped} of ${consumes.length} route(s) declare responseFields; the rest were checked for existence and headers only.`,
    ),
  );
}

export function printReport(
  classified: ClassifiedChange[],
  explanation: ExplainResult | null,
  rawCount: number,
): void {
  const of = (severity: Severity) => classified.filter((c) => c.severity === severity);

  console.log(
    `Changes to ${classified.length} consumed operation(s) — ${of('breaking').length} breaking, ` +
      `${of('relevant').length} relevant, ${of('ignore').length} ignored (of ${rawCount} raw changes):`,
  );

  for (const severity of GROUPS) {
    // Already in Phase 3's (path, method) order — filtering preserves it.
    const group = of(severity);
    if (group.length === 0) continue;

    console.log(`\n${paint(`${severity.toUpperCase()} (${group.length})`, severity)}`);

    for (const change of group) {
      if (severity === 'ignore') {
        // Compact: one line, no raw detail, no LLM text.
        console.log(paint(`  ${heading(change)} — ${change.reasons.join('; ')}`, severity));
        continue;
      }

      console.log(`  ${paint(heading(change), severity)}`);
      change.reasons.forEach((reason, i) => {
        console.log(`      ${reason}`);
        const raw = change.rawChanges[i];
        if (raw) console.log(`          ${formatRawChange(raw)}`);
      });

      const note = explanation?.operations.find(
        (o) => o.method === change.method && o.path === change.path,
      );
      if (note) {
        console.log(`    impact: ${note.impact}`);
        console.log(`    action: ${note.action}`);
      }
    }
  }

  if (of('breaking').length === 0 && of('relevant').length === 0) {
    console.log('\nNothing needs action — every change above is cosmetic.');
  }

  if (explanation) {
    console.log('\n--- message for the backend team ---');
    console.log(explanation.backendMessage);
    console.log('--- end message ---');
  }
}
