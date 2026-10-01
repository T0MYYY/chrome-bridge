chrome.storage.local.get(['connected', 'lastConnect']).then((d) => {
  const on = !!d.connected;
  document.getElementById('dot').className = 'dot ' + (on ? 'on' : 'off');
  document.getElementById('state').textContent = on
    ? '已连接到 Claude Code'
    : '未连接 — 连接器没在跑?';
});
