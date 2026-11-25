/* SnowMail admin-only UI. API credentials never enter browser storage. */
(() => {
  const $ = id => document.getElementById(id);
  let token = '', inspection = null, selectionVersion = 0, refreshing = false, busy = false;
  const json = body => ({ headers: requestHeaders(true), body: JSON.stringify(body) });
  const notice = (message = '', error = false) => {
    $('amelu-notice').textContent = message;
    $('amelu-notice').classList.toggle('error', error);
  };
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function button(text, action, primary = false) {
    const element = node('button', text, primary ? 'btn-primary' : 'btn-secondary');
    element.type = 'button';
    element.style.minHeight = '34px';
    element.style.padding = '0 13px';
    element.style.fontSize = '12.5px';
    element.onclick = async () => {
      element.disabled = true;
      try { await action(); } catch (error) { notice(error.message, true); }
      finally { element.disabled = false; }
    };
    return element;
  }
  function reset() {
    selectionVersion++;
    token = '';
    inspection = null;
    $('amelu-key').value = '';
    $('amelu-connect-form').hidden = true;
    $('amelu-discover-form').hidden = false;
    $('amelu-confirm').checked = false;
    $('amelu-risk').checked = false;
  }
  function busyForm(value) {
    busy = value;
    ['amelu-connect', 'amelu-domain', 'amelu-cancel', 'amelu-routing', 'amelu-confirm', 'amelu-risk'].forEach(id => $(id).disabled = value);
    $('amelu-connect').textContent = value ? '配置收信中...' : '确认接入';
  }

  $('amelu-discover-form').onsubmit = async event => {
    event.preventDefault();
    const key = $('amelu-key').value.trim();
    $('amelu-discover').disabled = true;
    $('amelu-discover').textContent = '读取中...';
    notice();
    try {
      const result = await apiFetch('/api/amelu/discover', { method: 'POST', ...json({ apiKey: key }) });
      $('amelu-key').value = '';
      token = result.token;
      $('amelu-domain').replaceChildren();
      if (!result.domains.length) { notice('该账号下暂无可用域名，请先在 Amelu 添加域名并配置 DNS。'); return; }
      result.domains.forEach(domain => {
        const option = node('option', domain.name + (domain.connected ? ' (已接入)' : ''));
        option.value = domain.id;
        $('amelu-domain').append(option);
      });
      $('amelu-discover-form').hidden = true;
      $('amelu-connect-form').hidden = false;
      await inspect();
    } catch (error) { if (!handleAdminError(error)) notice(error.message, true); }
    finally { $('amelu-discover').disabled = false; $('amelu-discover').textContent = '读取域名'; }
  };

  async function inspect() {
    const version = ++selectionVersion;
    inspection = null;
    $('amelu-connect').disabled = true;
    $('amelu-confirm').checked = false;
    $('amelu-risk').checked = false;
    $('amelu-domain-info').textContent = '正在检查域名收信与 DNS 设置...';
    notice();
    try {
      const result = await apiFetch('/api/amelu/inspect', { method: 'POST', ...json({ token, domainId: $('amelu-domain').value }) });
      if (version !== selectionVersion) return;
      inspection = result;
      $('amelu-routing').value = result.routing;
      $('amelu-risk-wrap').hidden = result.routing !== 'headers';
      const missing = result.dns.filter(r => r.status !== 'matched');
      $('amelu-domain-info').textContent = `已有 ${result.mailboxes.length} 个独立邮箱。` +
        (result.catchall ? ` 当前 Catch-all：${result.catchall}。` : ' 尚未设置 Catch-all，确认后将自动创建专用汇集邮箱。') +
        (missing.length ? ` 有 ${missing.length} 项 DNS 尚未通过检查，请在 Amelu 核对 MX 记录。` : ' DNS 检查通过。');
      $('amelu-setup-copy').textContent = result.catchall
        ? `沿用 ${result.catchall} 收信，不修改现有 Catch-all，仅同步接入后的新邮件。`
        : '允许创建专用汇集邮箱并设为 Catch-all，仅同步接入后的新邮件。';
      $('amelu-connect').disabled = false;
    } catch (error) { if (version === selectionVersion) notice(error.message, true); }
  }
  $('amelu-domain').onchange = inspect;
  $('amelu-routing').onchange = () => {
    $('amelu-risk-wrap').hidden = $('amelu-routing').value !== 'headers';
    $('amelu-risk').checked = false;
  };
  $('amelu-cancel').onclick = () => { if (!busy) { reset(); notice(); } };
  $('amelu-connect-form').onsubmit = async event => {
    event.preventDefault();
    if (!inspection || busy) return;
    if ($('amelu-routing').value === 'headers' && !$('amelu-risk').checked) {
      notice('请先勾选确认自动分配的适用范围，或改回人工确认分配。', true); return;
    }
    busyForm(true);
    notice('正在验证收件邮箱并保存加密连接...');
    try {
      const result = await apiFetch('/api/amelu/connections', {
        method: 'POST',
        ...json({
          token,
          domainId: $('amelu-domain').value,
          expectedCatchall: inspection.catchall,
          routing: $('amelu-routing').value,
          acceptHeaderRisk: $('amelu-risk').checked,
          confirmSetup: $('amelu-confirm').checked,
        }),
      });
      reset();
      await fetchConfig();
      state.selectedDomain = result.domain;
      renderDomainOptions();
      renderMailboxes();
      notice(`已成功接入 ${result.domain}，现在可以创建该域名下的临时邮箱。`);
      await refresh(true);
    } catch (error) { notice(error.message + ' 已完成步骤会保留，修正后可重试。', true); }
    finally { busyForm(false); }
  };

  function renderConnections(connections) {
    const root = $('amelu-connections');
    root.replaceChildren();
    if (!connections.length) {
      root.append(node('div', '尚未接入任何 Amelu 域名。在上方填入 API Key 即可开始连接。', 'amelu-empty'));
    }
    connections.forEach(c => {
      const entry = node('article', undefined, 'amelu-entry');
      entry.append(node('h4', c.domain));
      const labels = { setup: '待完成配置', ready: '已连接', paused: '已暂停', error: '同步异常' };
      entry.append(node('span', (c.syncing ? '正在同步' : labels[c.status] || c.status) + ` · ${c.routing === 'headers' ? '按信头分配' : '每封确认分配'}`, 'amelu-status'));
      entry.append(node('p', `收件邮箱：${c.mailbox_address || '配置中'} · 待分配 ${c.pending_count} 封`));
      entry.append(node('p', c.last_sync ? `上次同步：${formatTime(c.last_sync)}` : '等待首次同步'));
      if (c.last_error) entry.append(node('p', c.last_error, 'amelu-error'));
      const actions = node('div', undefined, 'amelu-actions');
      if (c.status !== 'setup') {
        const syncButton = button('立即同步', async () => {
          notice('正在同步邮件...');
          const result = await apiFetch(`/api/amelu/connections/${encodeURIComponent(c.id)}/sync`, { method: 'POST' });
          notice(`同步完成：导入 ${result.imported || 0} 封，新增待分配 ${result.pending || 0} 封。`);
          await refresh(true); await refreshShellData(); await refreshSelectedMailbox();
        }, true);
        syncButton.disabled = !c.enabled || c.syncing;
        actions.append(syncButton, button(c.enabled ? '暂停同步' : '恢复同步', async () => {
          await apiFetch(`/api/amelu/connections/${encodeURIComponent(c.id)}`, { method: 'PATCH', ...json({ enabled: !c.enabled }) });
          notice(c.enabled ? '已暂停本地同步。' : '已恢复本地同步。');
          await fetchConfig(); await refresh(true);
        }));
      }
      actions.append(button('重新连接', async () => {
        reset();
        $('amelu-key').focus();
        notice('填入新的 API Key 后选择该域名，即可更新凭据与分配方式。');
      }));
      entry.append(actions);
      root.append(entry);
    });
    $('amelu-pending-count').textContent = String(connections.reduce((sum, c) => sum + c.pending_count, 0));
  }

  function renderPending(messages) {
    const root = $('amelu-pending');
    const choices = new Map(Array.from(root.querySelectorAll('select[data-message-id]')).map(select => [select.dataset.messageId, select.value]));
    root.replaceChildren();
    if (!messages.length) {
      root.append(node('div', '没有待分配邮件。需要人工确认所属地址的邮件会集中显示在这里。', 'amelu-empty'));
    }
    messages.forEach(m => {
      const entry = node('article', undefined, 'amelu-entry');
      entry.append(
        node('h4', m.subject || '(无主题)'),
        node('p', `${m.sender} · ${formatTime(m.received_at)}`),
        node('p', m.reason),
        node('p', `接收域名：${m.domain}`)
      );
      if (m.candidates.length) entry.append(node('p', '候选地址：' + m.candidates.join('、')));
      const detail = node('details');
      detail.append(node('summary', '查看正文摘要'), node('pre', m.preview || '无文本摘要'));
      entry.append(detail);

      const actions = node('div', undefined, 'amelu-actions');
      const select = node('select');
      select.dataset.messageId = String(m.id);
      select.setAttribute('aria-label', `为 ${m.subject || '这封邮件'} 选择目标邮箱`);
      const placeholder = node('option', '选择实际收件邮箱');
      placeholder.value = '';
      select.append(placeholder);

      const eligible = state.mailboxes.filter(box => getMailboxDomain(box.address) === m.domain &&
        Date.parse(box.created_at + 'Z') <= Date.parse(m.received_at) &&
        (!box.expires_at || Date.parse(box.expires_at + 'Z') > Date.now()));
      eligible.forEach(box => {
        const option = node('option', box.address);
        option.value = box.address;
        select.append(option);
      });
      const previousChoice = choices.get(String(m.id));
      if (eligible.some(box => box.address === previousChoice)) select.value = previousChoice;
      if (!eligible.length) {
        select.disabled = true;
        entry.append(node('p', '暂无可分配地址：目标邮箱需在收信前已创建且未过期。可忽略此邮件。'));
      }
      const assignButton = button('确认分配', async () => {
        if (!select.value) return;
        await apiFetch(`/api/amelu/pending/${m.id}/assign`, { method: 'POST', ...json({ address: select.value }) });
        notice('邮件已分配到 ' + select.value);
        await refresh(true); await refreshShellData();
      }, true);
      assignButton.dataset.action = 'assign';
      assignButton.disabled = !select.value;
      select.onchange = () => assignButton.disabled = !select.value;
      actions.append(select, assignButton, button('忽略', async () => {
        await apiFetch(`/api/amelu/pending/${m.id}`, { method: 'DELETE' });
        notice('已从待分配列表移除，Amelu 原件保留。');
        await refresh(true);
      }));
      entry.append(actions);
      root.append(entry);
    });
  }

  async function refresh(force = false) {
    if (refreshing) return;
    if (!force && $('amelu-pending').contains(document.activeElement)) return;
    refreshing = true;
    try {
      const [connections, pending] = await Promise.all([
        apiFetch('/api/amelu/connections'),
        apiFetch('/api/amelu/pending'),
      ]);
      if (!force && $('amelu-pending').contains(document.activeElement)) return;
      renderConnections(connections.connections);
      renderPending(pending.messages);
    } catch (error) { if (!handleAdminError(error)) notice(error.message, true); }
    finally { refreshing = false; }
  }
  $('amelu-refresh').onclick = () => refresh(true);
  window.AmeluAdmin = { refresh };
})();
