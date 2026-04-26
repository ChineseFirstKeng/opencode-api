const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  bold: '\x1b[1m',
};

export function log(tag: string, msg: string, color: string = COLORS.reset) {
  const time = new Date().toLocaleTimeString();
  console.log(`${COLORS.dim}[${time}]${COLORS.reset} ${color}${tag}${COLORS.reset} ${msg}`);
}

export function formatBody(body: unknown, maxLength = 50000): string {
  const str = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  if (str.length > maxLength) {
    return str.slice(0, maxLength) + '...';
  }
  return str;
}

export { COLORS };
