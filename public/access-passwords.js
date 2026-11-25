(() => {
  const $ = id => document.getElementById(id);
  let refreshing = false;
  let createdId = '';

  function notice(message, error = false) {
    $('access-notice').textContent = message;
    $('access-notice').classList.toggle('error', error);
  }

  function forgetPassword() {
    $('access-secret').value = '';
    $('access-created').hidden = true;
    createdId = '';
  }

  function date(value) {
    return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未使用';
  }

  function button(label, className, onClick) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.style.minHeight = '32px';
    element.style.padding = '0 12px';
    element.style.fontSize = '12px';
    element.textContent = label;
    element.onclick = onClick;
    return element;
  }

  function render(records) {
    const root = $('access-password-list');
    root.replaceChildren();
    if (!records.length) {
      const empty = document.createElement('p');
      empty.className = 'passwords-empty';
      empty.textContent = '还没有操作密码。在左侧填写用途备注即可创建。';
      root.append(empty);
      return;
    }
    records.forEach(record => {
      const row = document.createElement('div');
      row.className = 'passwords-entry';
      const info = document.createElement('div');
      info.className = 'passwords-entry-info';
      const title = document.createElement('div');
      title.className = 'passwords-entry-title';
      title.textContent = record.label;
      const badge = document.createElement('span');
      badge.className = record.revoked_at ? 'pw-badge-revoked' : 'pw-badge-active';
      badge.textContent = record.revoked_at ? '已撤销' : '生效中';
      title.append(badge);

      const meta = document.createElement('div');
      meta.className = 'passwords-entry-meta';
      meta.textContent = `创建：${date(record.created_at)} · 最近使用：${date(record.last_used_at)}`;
      info.append(title, meta);
      row.append(info);

      if (!record.revoked_at) {
        const actions = document.createElement('div');
        actions.className = 'passwords-entry-actions';
        const revoke = button('撤销', 'btn-danger', () => {
          const confirm = button('确认撤销', 'btn-danger', async () => {
            confirm.disabled = true;
            cancel.disabled = true;
            confirm.textContent = '撤销中...';
            try {
              await apiFetch(`/api/admin/access-passwords/${encodeURIComponent(record.id)}`, { method: 'DELETE' });
              if (createdId === record.id) forgetPassword();
              notice(`已撤销「${record.label}」，该密码和已有登录已失效。`);
              await refresh();
            } catch (error) {
              if (!handleAdminError(error)) notice(error.message || '撤销失败，请重试。', true);
              actions.replaceChildren(revoke);
            }
          });
          const cancel = button('取消', 'btn-secondary', () => { actions.replaceChildren(revoke); revoke.focus(); });
          actions.replaceChildren(confirm, cancel);
          confirm.focus();
        });
        revoke.setAttribute('aria-label', `撤销 ${record.label}`);
        actions.append(revoke);
        row.append(actions);
      }
      root.append(row);
    });
  }

  async function refresh() {
    if (state.role !== 'admin' || refreshing) return;
    refreshing = true;
    $('access-refresh').disabled = true;
    try {
      const result = await apiFetch('/api/admin/access-passwords');
      render(result.passwords);
    } catch (error) {
      if (!handleAdminError(error)) notice(error.message || '加载失败，请刷新列表。', true);
    } finally {
      refreshing = false;
      $('access-refresh').disabled = false;
    }
  }

  $('access-create-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (state.role !== 'admin') return;
    const label = $('access-label').value.trim();
    if (!label) { notice('请填写用途备注。', true); $('access-label').focus(); return; }
    $('access-create').disabled = true;
    $('access-create').textContent = '创建中...';
    notice('');
    forgetPassword();
    try {
      const result = await apiFetch('/api/admin/access-passwords', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }),
      });
      createdId = result.id;
      $('access-secret').value = result.password;
      $('access-created').hidden = false;
      $('access-label').value = '';
      $('access-copy').focus();
      await refresh();
    } catch (error) {
      if (!handleAdminError(error)) notice(error.message || '创建失败，请重试。', true);
    } finally {
      $('access-create').disabled = false;
      $('access-create').textContent = '创建操作密码';
    }
  });

  $('access-copy').onclick = () => copyText($('access-secret').value, '操作密码已复制');
  $('access-copy-instructions').onclick = () => {
    const password = $('access-secret').value;
    if (!password) return;
    copyText(`SnowMail 临时邮箱\n地址：${location.origin}\n操作密码：${password}\n权限：创建、删除所有临时邮箱，查看邮箱和邮件。\nAPI 请求头：Authorization: Bearer ${password}\nGET /api/config 获取可用域名\nPOST /api/generate 创建邮箱，JSON 示例：{"custom":"project-test","domain":"从 config 选择域名","retention_hours":24}\nGET /api/mailboxes 列出邮箱\nGET /api/mailbox/:address 读取邮件\nGET /api/mailbox/:address/wait?timeout=30 等待新邮件\nGET /api/email/:id 读取邮件正文\nDELETE /api/mailboxes/:address 删除邮箱及本地邮件\n地址参数请做 URL 编码。也可以用此密码登录网页。`, '给 AI 的接入信息已复制');
  };
  $('access-dismiss').onclick = () => { forgetPassword(); $('access-label').focus(); };
  $('access-refresh').onclick = refresh;
  window.addEventListener('pagehide', forgetPassword);
  window.AccessPasswords = { refresh };
})();
