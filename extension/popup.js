// 弹窗: 实时状态 (打开时顺带唤醒 service worker 立即重扫端口)、输入配对码、撤销已配对的 agent
const $ = (id) => document.getElementById(id);
const ask = (msg) => chrome.runtime.sendMessage(msg);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const ago = (t) => {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? '刚刚' : s < 3600 ? `${Math.round(s / 60)} 分钟前` : s < 86400 ? `${Math.round(s / 3600)} 小时前` : `${Math.round(s / 86400)} 天前`;
};

let lastKey = '';

function render(s) {
  // 内容没变就不重绘, 免得打断正在输入的配对码
  const key = JSON.stringify(s, (k, v) => (k === 'lastSeen' ? undefined : v));
  if (key === lastKey) return;
  lastKey = key;

  const n = s.sessions.length;
  $('dot').className = 'dot ' + (n ? 'on' : 'off');
  $('state').textContent = n ? `已接入 ${n} 个 agent 会话` : s.pending.length ? '有 agent 等待配对' : '没有 agent 会话在运行';

  $('pairBox').hidden = !s.pending.length;
  $('pendingList').replaceChildren(
    ...s.pending.map((p) => {
      const c = el('div', 'card pending');
      c.append(el('div', '', p.agent || '未识别的 agent'), el('div', 'meta', `${p.cwd || ''} · 端口 ${p.port}`));
      return c;
    })
  );
  if (s.pending.length && document.activeElement !== $('code')) $('code').focus();

  $('sessionBox').hidden = !n;
  $('sessionList').replaceChildren(
    ...s.sessions.map((c) => {
      const d = el('div', 'card');
      d.append(el('div', '', c.agent || '未识别的 agent'), el('div', 'meta', `${c.cwd} · 端口 ${c.port} · pid ${c.pid} · 附加 ${c.tabs} 个标签`));
      return d;
    })
  );

  $('agentBox').hidden = !s.agents.length;
  $('agentList').replaceChildren(
    ...s.agents
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
      .map((a) => {
        const d = el('div', 'card');
        const head = el('div', 'agent');
        head.append(el('span', '', a.label || '未识别的 agent'));
        const btn = el('button', 'link', '撤销');
        // 两步确认 (弹窗里的 confirm() 不可靠): 第一次点变成「确认撤销」, 3 秒内再点才生效
        btn.onclick = async () => {
          if (btn.dataset.armed !== '1') {
            btn.dataset.armed = '1';
            btn.textContent = '确认撤销?';
            setTimeout(() => {
              btn.dataset.armed = '';
              btn.textContent = '撤销';
            }, 3000);
            return;
          }
          await ask({ type: 'revoke', pub: a.pub });
          lastKey = '';
          refresh();
        };
        head.append(btn);
        const strength = { signed: '代码签名验证', path: '按路径识别 (未签名)', ephemeral: '仅限当时的会话' }[a.strength] || '';
        d.append(head, el('div', 'meta', [a.online ? '在线' : `最近使用 ${ago(a.lastSeen)}`, strength, a.client, `密钥 ${a.fp}`].filter(Boolean).join(' · ')));
        return d;
      })
  );

  $('hint').innerHTML = `v${s.version} · 扫描 <code>127.0.0.1:${s.basePort}-${s.basePort + s.span - 1}</code>`;
}

async function refresh() {
  try {
    render(await ask({ type: 'status' }));
  } catch {
    $('state').textContent = '扩展后台未响应';
  }
}

async function pair() {
  const code = $('code').value.trim();
  if (!code) return;
  $('pairBtn').disabled = true;
  $('pairMsg').className = 'msg';
  $('pairMsg').textContent = '验证中…';
  const r = await ask({ type: 'pair', code }).catch((e) => ({ ok: false, error: String(e) }));
  $('pairBtn').disabled = false;
  $('pairMsg').className = 'msg ' + (r.ok ? 'ok' : 'err');
  $('pairMsg').textContent = r.ok ? `已配对: ${r.agent || 'agent'}。它以后的会话都不用再配对。` : r.error;
  if (r.ok) $('code').value = '';
  refresh();
}

// 输入时自动加横杠: XXXX-XXXX
$('code').addEventListener('input', (e) => {
  const v = e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
  e.target.value = v.length > 4 ? v.slice(0, 4) + '-' + v.slice(4) : v;
  if (v.length === 8) pair();
});
$('code').addEventListener('keydown', (e) => e.key === 'Enter' && pair());
$('pairBtn').onclick = pair;

refresh();
setInterval(refresh, 1000);
