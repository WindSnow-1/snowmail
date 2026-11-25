(() => {
  const $ = id => document.getElementById(id);
  let refreshing = false;
  let createdId = '';
  let masterToggledManually = false;

  function notice(message, error = false) {
    $('access-notice').textContent = message;
    $('access-notice').classList.toggle('error', error);
  }

  function masterNotice(message, error = false) {
    const el = $('master-pw-notice');
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('error', error);
  }

  function clearMasterInputs() {
    if ($('master-current')) $('master-current').value = '';
    if ($('master-new')) $('master-new').value = '';
    if ($('master-confirm')) $('master-confirm').value = '';
  }

  function setMasterFormOpen(open) {
    const form = $('master-pw-form');
    const toggle = $('master-pw-toggle');
    if (!form || !toggle) return;
    form.hidden = !open;
    toggle.textContent = open ? '收起' : '修改主密码';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) {
      clearMasterInputs();
    }
  }

  function renderMaster(master) {
    const card = $('master-pw-card');
    const badge = $('master-pw-badge');
    const meta = $('master-pw-meta');
    if (!card || !badge || !meta || !master) return;

    const isWeak = Boolean(master.using_default_weak);
    card.classList.toggle('is-weak-default', isWeak);

    if (isWeak) {
      badge.className = 'pw-badge-warn';
      badge.textContent = '默认弱密码 · 请立即修改';
      meta.textContent = '检测到当前仍在使用默认弱密码，建议立即更换为专属高强度主密码。';
      if (!masterToggledManually) {
        setMasterFormOpen(true);
      }
      return;
    }

    if (master.source === 'custom') {
      badge.className = 'pw-badge-active';
      badge.textContent = '已设自定义密码';
      meta.textContent = `上次网页改密：${date(master.updated_at)}（初始环境变量密码已作废）`;
      return;
    }

    badge.className = 'pw-badge-active';
    badge.textContent = '环境变量密钥';
    meta.textContent = '当前使用服务器环境变量配置的初始密钥，可随时在此更换为新的主密码。';
  }

  function forgetPassword() {
    $('access-secret').value = '';
    $('access-created').hidden = true;
    createdId = '';
    clearMasterInputs();
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
      render(result.passwords || []);
      renderMaster(result.master);
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

  if ($('master-pw-toggle')) {
    $('master-pw-toggle').onclick = () => {
      masterToggledManually = true;
      masterNotice('');
      const nextOpen = Boolean($('master-pw-form')?.hidden);
      setMasterFormOpen(nextOpen);
      if (nextOpen) setTimeout(() => $('master-current')?.focus(), 30);
    };
  }

  if ($('master-pw-cancel')) {
    $('master-pw-cancel').onclick = () => {
      masterToggledManually = true;
      masterNotice('');
      setMasterFormOpen(false);
    };
  }

  if ($('master-pw-form')) {
    $('master-pw-form').addEventListener('submit', async event => {
      event.preventDefault();
      if (state.role !== 'admin') return;

      const currentPassword = $('master-current').value;
      const newPassword = $('master-new').value;
      const confirmPassword = $('master-confirm').value;

      if (!currentPassword) {
        masterNotice('请输入当前主密码。', true);
        $('master-current').focus();
        return;
      }
      if (newPassword.length < 8) {
        masterNotice('新主密码长度不能少于 8 个字符。', true);
        $('master-new').focus();
        return;
      }
      if (newPassword.startsWith('smop_')) {
        masterNotice('新主密码不能以 smop_ 开头。', true);
        $('master-new').focus();
        return;
      }
      if (newPassword !== confirmPassword) {
        masterNotice('两次输入的新主密码不一致，请重新确认。', true);
        $('master-confirm').focus();
        return;
      }
      if (newPassword === currentPassword) {
        masterNotice('新主密码不能与当前主密码相同。', true);
        $('master-new').focus();
        return;
      }

      const submitBtn = $('master-pw-submit');
      submitBtn.disabled = true;
      submitBtn.textContent = '保存中...';
      masterNotice('');

      try {
        const result = await apiFetch('/api/admin/master-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            current_password: currentPassword,
            new_password: newPassword,
          }),
        });
        masterToggledManually = true;
        setMasterFormOpen(false);
        renderMaster(result.master);
        masterNotice('主管理员密码已更新，其他设备上的旧管理员登录已自动失效。');
        if (typeof toast === 'function') toast('主管理员密码已更新');
      } catch (error) {
        if (!handleAdminError(error)) {
          masterNotice(error.message || '修改主密码失败，请重试。', true);
        }
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '保存新主密码';
      }
    });
  }

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
