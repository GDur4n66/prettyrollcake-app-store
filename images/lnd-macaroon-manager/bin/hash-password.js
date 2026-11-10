// パスワードを入力して ADMIN_PASSWORD_HASH の値を出す
import { createInterface } from 'node:readline';
import { hashPassword } from '../src/auth.js';

const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
rl._writeToOutput = (s) => {
  if (s.includes('パスワード')) process.stderr.write(s);
};
rl.question('パスワード: ', (pw) => {
  rl.close();
  process.stderr.write('\n');
  if (pw.length < 10) {
    console.error('10 文字以上にしてください');
    process.exit(1);
  }
  console.log(`ADMIN_PASSWORD_HASH=${hashPassword(pw)}`);
});
