/* 状态落盘：只有 json，没有数据库
 *
 * 写入用「临时文件 + rename」：rename 在同一分区上是原子的，
 * master 进程被杀在写一半的时候也不会留下半个 JSON。
 */

import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function writeJsonAtomic(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    if (e instanceof SyntaxError) throw new Error(`${file} 不是合法 JSON：${e.message}`);
    throw e;
  }
}

/** 只读文件是否存在且可解析，用于启动自检 */
export async function readJsonSafe(file) {
  try {
    return await readJson(file);
  } catch {
    return null;
  }
}
