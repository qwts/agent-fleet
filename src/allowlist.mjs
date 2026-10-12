// The read-only contract (ADR-0001 §2), enforced. Every probe command is an
// argv array that must match one of these shapes before it can reach ssh.
// Nothing else runs: no shell syntax, no options beyond those listed, and no
// program that installs, writes or prompts.

export class ProbeNotAllowed extends Error {}

// Programs that must never run, even as `<program> --version`.
const NEVER = new Set(['brew', 'keyd', 'agent-bot-keyd', 'managed-machine', 'sudo', 'su', 'sh', 'bash', 'zsh', 'env']);

// Printable, no shell metacharacters: arguments are quoted anyway, so this
// is defence in depth.
const SAFE_ARG = /^[A-Za-z0-9 ._,:@+/=-]+$/;
const PATH_ARG = /^(?:\/|\.?[A-Za-z0-9_])[A-Za-z0-9 ._@+/-]*$/;
// Only these programs may be asked for --version, by name or by path.
const VERSIONED = new Set(['agent-bot', 'agent-comms']);
const NAME_ARG = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

const isPath = (s) => PATH_ARG.test(s) && !s.split('/').includes('..');
const isName = (s) => NAME_ARG.test(s);

// Container inspection: four exact argv shapes, matched by whole-argv literal
// equality. The `{{json .}}` argument carries braces that the general
// SAFE_ARG gate below rejects, so these shapes are checked first — but only
// as complete argv arrays, never per argument. No other docker/podman
// invocation (exec, run, logs, inspect, pull, start, create, desktop, …)
// matches, so nothing that launches, writes or prompts can slip through.
const CONTAINER_SHAPES = [
  ['docker', 'version', '--format', '{{json .}}'],
  ['docker', 'ps', '--all', '--no-trunc', '--format', '{{json .}}'],
  ['podman', 'version', '--format', '{{json .}}'],
  ['podman', 'ps', '--all', '--no-trunc', '--format', '{{json .}}'],
];
const isContainerShape = (a) => Array.isArray(a) && CONTAINER_SHAPES.some((s) => s.length === a.length && s.every((v, i) => a[i] === v));
const isExact = (shape) => (a) => Array.isArray(a) && shape.length === a.length && shape.every((v, i) => a[i] === v);

// Each rule: [name, predicate over the whole argv].
const RULES = [
  ['cat FILE', (a) => a.length === 2 && a[0] === 'cat' && isPath(a[1])],
  ['test -e|-f|-d PATH', (a) => a.length === 3 && a[0] === 'test' && ['-e', '-f', '-d'].includes(a[1]) && isPath(a[2])],
  ['readlink [-f] PATH', (a) => a[0] === 'readlink' && ((a.length === 2 && isPath(a[1])) || (a.length === 3 && a[1] === '-f' && isPath(a[2])))],
  ['defaults read DOMAIN [KEY]', (a) => (a.length === 3 || a.length === 4) && a[0] === 'defaults' && a[1] === 'read' && isPath(a[2]) && (a.length === 3 || isName(a[3]))],
  ['launchctl list', (a) => a.length === 2 && a[0] === 'launchctl' && a[1] === 'list'],
  ['systemctl --user is-active UNIT...', (a) => a.length >= 4 && a[0] === 'systemctl' && a[1] === '--user' && a[2] === 'is-active' && a.slice(3).every(isName)],
  ['command -v NAME', (a) => a.length === 3 && a[0] === 'command' && a[1] === '-v' && isName(a[2])],
  ['agent-bot|agent-comms --version', (a) => a.length === 2 && a[1] === '--version' && (isName(a[0]) || isPath(a[0])) && VERSIONED.has(a[0].split('/').pop())],
  ['docker version --format {{json .}}', isExact(CONTAINER_SHAPES[0])],
  ['docker ps --all --no-trunc --format {{json .}}', isExact(CONTAINER_SHAPES[1])],
  ['podman version --format {{json .}}', isExact(CONTAINER_SHAPES[2])],
  ['podman ps --all --no-trunc --format {{json .}}', isExact(CONTAINER_SHAPES[3])],
];

export function assertAllowed(argv) {
  // The four container shapes carry braces, so they are matched by exact
  // literal equality before the SAFE_ARG gate, which is unchanged for
  // everything else.
  if (isContainerShape(argv)) return argv;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 512 && SAFE_ARG.test(s))) {
    throw new ProbeNotAllowed(`probe refused: ${JSON.stringify(argv)}`);
  }
  const program = argv[0].split('/').pop();
  if (NEVER.has(program)) throw new ProbeNotAllowed(`probe refused: ${program} is never run`);
  if (!RULES.some(([, ok]) => ok(argv))) throw new ProbeNotAllowed(`probe refused: ${JSON.stringify(argv)} matches no allowed shape`);
  return argv;
}

export function isAllowed(argv) {
  try {
    assertAllowed(argv);
    return true;
  } catch {
    return false;
  }
}

export const allowedShapes = () => RULES.map(([name]) => name);

// ssh hands the remote side one string for its login shell, so each argument
// is single-quoted. Relative paths resolve against the remote HOME, which is
// where ssh starts.
export function toRemoteCommand(argv) {
  assertAllowed(argv);
  return argv.map((s) => `'${s.replaceAll("'", "'\\''")}'`).join(' ');
}
