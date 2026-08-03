// NO_COLOR convention: any value means off. Piped/redirected output is never colored.
export const colorEnabled = (): boolean => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const wrap = (code: string) => (text: string) => (colorEnabled() ? `${code}${text}\x1b[0m` : text);

export const red = wrap('\x1b[31m');
export const green = wrap('\x1b[32m');
export const cyan = wrap('\x1b[36m');
export const dim = wrap('\x1b[2m');
export const bold = wrap('\x1b[1m');
