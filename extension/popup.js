const button = document.querySelector('#toggle');
const control = document.querySelector('#control');
const stateLabel = document.querySelector('#control-state');
const notice = document.querySelector('#notice');
const noticeText = document.querySelector('#notice-text');
const errorPanel = document.querySelector('#connection-error');
const errorText = document.querySelector('#error-text');
const retry = document.querySelector('#retry');
const REQUEST_TIMEOUT_MS = 5000;
let pending = false;
let knownStatus = null;

async function request(type) {
  let timer;
  try {
    const status = await Promise.race([
      chrome.runtime.sendMessage({type}),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Status request timed out')), REQUEST_TIMEOUT_MS);
      }),
    ]);
    if (!status || typeof status.enabled !== 'boolean' ||
        (status.notice != null && typeof status.notice !== 'string')) {
      throw new Error('Invalid status response');
    }
    return status;
  } finally {
    clearTimeout(timer);
  }
}

function render(status) {
  knownStatus = status;
  control.dataset.phase = 'ready';
  control.dataset.enabled = String(status.enabled);
  button.setAttribute('aria-checked', String(status.enabled));
  stateLabel.textContent = status.enabled ? 'Включено' : 'Отключено';
  noticeText.textContent = status.notice || '';
  notice.hidden = !status.notice;
  errorPanel.hidden = true;
}

async function perform(type, restoreFocus = false) {
  if (pending || (type === 'toggle' && !knownStatus)) return;
  pending = true;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  retry.disabled = true;
  control.dataset.phase = type === 'toggle' ? 'saving' : 'loading';
  stateLabel.textContent = type === 'toggle' ? 'Меняем состояние…' : 'Проверяем состояние…';
  try {
    render(await request(type));
  } catch {
    // A toggle can finish after a timeout. Recovery reads state, never repeats the mutation.
    knownStatus = null;
    control.dataset.phase = 'error';
    stateLabel.textContent = 'Состояние недоступно';
    errorText.textContent = 'Не удалось проверить состояние расширения. Повторите проверку или откройте окно заново.';
    errorPanel.hidden = false;
  } finally {
    pending = false;
    button.disabled = !knownStatus;
    button.setAttribute('aria-busy', 'false');
    retry.disabled = false;
    if (restoreFocus) (knownStatus ? button : retry).focus({preventScroll: true});
  }
}

button.addEventListener('click', () => perform('toggle', true));
retry.addEventListener('click', () => perform('status', true));
perform('status');
