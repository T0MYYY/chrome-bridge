// 弹窗打开时向 service worker 要实时状态 (顺带唤醒它立即重扫端口), 打开期间每秒刷新
const $ = (id) => document.getElementById(id);

function render(s) {
  const sessions = s?.会话 || [];
  $('dot').className = 'dot ' + (sessions.length ? 'on' : 'off');
  $('state').textContent = sessions.length
    ? `已连接 ${sessions.length} 个 Claude Code 会话`
    : '未连接 — 没有 Claude Code 会话在跑?';
  $('list').replaceChildren(
    ...sessions.map((c) => {
      const li = document.createElement('li');
      const dir = document.createElement('div');
      dir.textContent = c.目录;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `端口 ${c.端口} · pid ${c.pid} · 附加 ${c.附加的标签.length} 个标签`;
      li.append(dir, meta);
      return li;
    })
  );
  if (s) $('hint').innerHTML = `v${s.version} · 扫描 <code>127.0.0.1:${s.basePort}-${s.basePort + s.span - 1}</code>`;
}

async function refresh() {
  try {
    render(await chrome.runtime.sendMessage({ type: 'status' }));
  } catch {
    render(null);
  }
}

refresh();
setInterval(refresh, 1000);
