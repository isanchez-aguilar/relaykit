import { createInterface } from 'node:readline/promises';

export async function confirm(question, { input = process.stdin, output = process.stdout } = {}) {
  const reader = createInterface({ input, output });
  const closed = new Promise(resolve => { reader.once('close', () => resolve('')); reader.once('SIGINT', () => { resolve(''); reader.close(); }); });
  try { return /^y(?:es)?$/i.test((await Promise.race([reader.question(question), closed])).trim()); }
  finally { reader.close(); }
}
