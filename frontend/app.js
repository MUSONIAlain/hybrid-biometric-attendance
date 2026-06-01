const serverStatus = document.getElementById('serverStatus');
const registrationForm = document.getElementById('registrationForm');
const registrationStatus = document.getElementById('registrationStatus');
const nameInput = document.getElementById('nameInput');
const biometricsToggle = document.getElementById('biometricsToggle');
const biometricsLabel = document.getElementById('biometricsLabel');
const usersBody = document.getElementById('usersBody');
const logsBody = document.getElementById('logsBody');

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : null;

  if (!response.ok) {
    throw new Error(data?.error || 'Request failed');
  }

  return data;
}

function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function setServerStatus(ok, text) {
  serverStatus.className = `status-pill ${ok ? 'ok' : 'fail'}`;
  serverStatus.textContent = text;
}

async function checkHealth() {
  try {
    await api('/api/health');
    setServerStatus(true, 'Server online');
  } catch (error) {
    setServerStatus(false, 'Server offline');
  }
}

async function loadUsers() {
  try {
    const users = await api('/api/users');

    if (!users.length) {
      usersBody.innerHTML = '<tr><td class="empty" colspan="5">No users registered yet.</td></tr>';
      return;
    }

    usersBody.innerHTML = users.map((user) => `
      <tr>
        <td>${escapeHtml(user.name)}</td>
        <td>${user.fingerprint_id}</td>
        <td>${escapeHtml(user.rfid_uid)}</td>
        <td>${formatDate(user.created_at)}</td>
        <td><button class="danger" data-delete-id="${user.id}">Delete</button></td>
      </tr>
    `).join('');
  } catch (error) {
    usersBody.innerHTML = `<tr><td class="empty" colspan="5">${error.message}</td></tr>`;
  }
}

async function loadLogs() {
  try {
    const logs = await api('/api/attendance/logs');

    if (!logs.length) {
      logsBody.innerHTML = '<tr><td class="empty" colspan="6">No attendance logs yet.</td></tr>';
      return;
    }

    logsBody.innerHTML = logs.map((log) => `
      <tr>
        <td>${escapeHtml(log.user_name || '-')}</td>
        <td>${escapeHtml(log.rfid_uid || '-')}</td>
        <td>${escapeHtml(log.fingerprint_id || '-')}</td>
        <td><span class="badge ${log.status === 'RECORDED' ? 'recorded' : 'denied'}">${log.status}</span></td>
        <td>${escapeHtml(log.message || '-')}</td>
        <td>${formatDate(log.created_at)}</td>
      </tr>
    `).join('');
  } catch (error) {
    logsBody.innerHTML = `<tr><td class="empty" colspan="6">${error.message}</td></tr>`;
  }
}

async function loadRegistrationStatus() {
  try {
    const data = await api('/api/registration/status');
    if (!data.active) {
      registrationStatus.textContent = 'No active registration.';
      return;
    }

    registrationStatus.textContent =
      `Registering ${data.registration.name}. ESP32 status: ${data.registration.status}.`;
  } catch (error) {
    registrationStatus.textContent = error.message;
  }
}

async function loadBiometrics() {
  try {
    const data = await api('/api/settings/biometrics');
    biometricsToggle.checked = data.enabled;
    biometricsLabel.textContent = data.enabled ? 'Enabled' : 'Disabled';
  } catch (error) {
    biometricsLabel.textContent = 'Unavailable';
  }
}

registrationForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    const name = nameInput.value.trim();
    const data = await api('/api/registration/start', {
      method: 'POST',
      body: JSON.stringify({ name })
    });

    registrationStatus.textContent = data.message;
    nameInput.value = '';
  } catch (error) {
    registrationStatus.textContent = error.message;
  }
});

biometricsToggle.addEventListener('change', async () => {
  try {
    const data = await api('/api/settings/biometrics', {
      method: 'PUT',
      body: JSON.stringify({ enabled: biometricsToggle.checked })
    });

    biometricsLabel.textContent = data.enabled ? 'Enabled' : 'Disabled';
  } catch (error) {
    biometricsLabel.textContent = error.message;
  }
});

usersBody.addEventListener('click', async (event) => {
  const id = event.target.dataset.deleteId;
  if (!id) return;

  const confirmed = confirm('Delete this user? The fingerprint template remains inside the sensor.');
  if (!confirmed) return;

  try {
    await api(`/api/users/${id}`, { method: 'DELETE' });
    await Promise.all([loadUsers(), loadLogs()]);
  } catch (error) {
    alert(error.message);
  }
});

document.getElementById('refreshUsers').addEventListener('click', loadUsers);
document.getElementById('refreshLogs').addEventListener('click', loadLogs);

async function boot() {
  await checkHealth();
  await Promise.all([
    loadUsers(),
    loadLogs(),
    loadRegistrationStatus(),
    loadBiometrics()
  ]);
}

boot();
setInterval(loadRegistrationStatus, 3000);
setInterval(loadLogs, 8000);
