function parsePartialJson(s) {
  if (!s || !s.trim()) return null;
  try { const v = JSON.parse(s); return typeof v === 'object' && v !== null ? v : null; } catch {}
  const result = {};
  const strRe = /"([^"\]*(?:\.[^"\]*)*)"(\s*:\s*)"([^"\]*(?:\.[^"\]*)*)"/g;
  let m;
  while ((m = strRe.exec(s)) !== null) result[m[1]] = m[3];
  const primRe = /"([^"\]*(?:\.[^"\]*)*)"(\s*:\s*)(-?\d+(?:\.\d+)?|true|false|null)/g;
  while ((m = primRe.exec(s)) !== null) {
    const key = m[1];
    if (key in result) continue;
    const raw = m[3];
    if (raw === 'true') result[key] = true;
    else if (raw === 'false') result[key] = false;
    else if (raw === 'null') result[key] = null;
    else result[key] = Number(raw);
  }
  return Object.keys(result).length > 0 ? result : null;
}

// 文件路径流式碎片
const fragments = ['', '{', '"file_', 'path', '"', ': ', '"data', '/workspaces', '/333/README.md', '"'];
console.log('=== 文件路径渐进解析 ===');
for (let i = 0; i < fragments.length; i++) {
  const acc = fragments.slice(0, i+1).join('');
  const parsed = parsePartialJson(acc);
  console.log(`Step ${i+1}: file_path=${JSON.stringify(parsed?.file_path ?? null)}`);
}

// 命令流式碎片
const cmdFragments = ['', '{', '"command"', ': ', '"ls -la', ' /tmp', '"'];
console.log('\n=== 命令渐进解析 ===');
for (let i = 0; i < cmdFragments.length; i++) {
  const acc = cmdFragments.slice(0, i+1).join('');
  const parsed = parsePartialJson(acc);
  console.log(`Step ${i+1}: command=${JSON.stringify(parsed?.command ?? null)}`);
}
