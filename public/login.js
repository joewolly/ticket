const form = document.getElementById('login-form');
const input = document.getElementById('password');
const error = document.getElementById('error');
const button = form.querySelector('button');

function showError(message) {
  error.textContent = message;
  error.hidden = false;
  input.select();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = true;
  button.disabled = true;
  button.textContent = 'Signing in…';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: input.value }),
    });

    if (res.ok) {
      // Full navigation rather than a hash change, so the app boots with the
      // session cookie already set.
      location.replace('/');
      return;
    }

    const payload = await res.json().catch(() => ({}));
    showError(payload.error ?? `Sign in failed (HTTP ${res.status})`);
  } catch {
    showError('Could not reach the server.');
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in';
  }
});
