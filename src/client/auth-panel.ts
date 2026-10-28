import { authErrorMessage, type FirebaseSession } from './auth';
import type { MessageKey } from './i18n';

export function renderAuthPanel(
  session: FirebaseSession,
  t: (key: MessageKey) => string,
  complete: () => void,
  cancel: () => void,
) {
  const page = document.createElement('section');
  page.className = 'auth-page';
  page.setAttribute('aria-labelledby', 'auth-heading');
  let active = true;
  let creating = false;
  let busy = false;
  let initialized = false;
  const heading = document.createElement('h1');
  heading.id = 'auth-heading';
  heading.textContent = t('auth.heading');
  heading.tabIndex = -1;
  const intro = document.createElement('p');
  intro.textContent = t('auth.intro');
  const status = document.createElement('p');
  status.className = 'auth-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const form = document.createElement('form');
  form.className = 'auth-form';
  function field(label: string, type: string, name: string) {
    const wrapper = document.createElement('label');
    wrapper.textContent = label;
    const input = document.createElement('input');
    input.type = type;
    input.name = name;
    input.required = true;
    input.autocomplete = name === 'password' ? 'current-password' : 'email';
    wrapper.appendChild(input);
    form.appendChild(wrapper);
    return input;
  }
  const email = field(t('auth.email'), 'email', 'email');
  const password = field(t('auth.password'), 'password', 'password');
  password.minLength = 6;
  function button(text: string, style = 'secondary-button') {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = style;
    element.textContent = text;
    return element;
  }
  const submit = button(t('auth.signIn'), 'auth-submit');
  submit.type = 'submit';
  const google = button(t('auth.google'));
  const toggle = button(t('auth.createAccount'), 'auth-text-button');
  const reset = button(t('auth.resetPassword'), 'auth-text-button');
  const back = button(t('auth.cancel'), 'auth-text-button');
  const retry = button(t('auth.retryAccount'));
  retry.hidden = true;
  form.appendChild(submit);
  const actions = document.createElement('div');
  actions.className = 'auth-actions';
  for (const element of [google, toggle, reset, retry, back]) actions.appendChild(element);
  for (const element of [heading, intro, form, actions, status]) page.appendChild(element);

  function sync() {
    const disabled = !initialized || busy || session.busy;
    for (const control of [submit, google, toggle, reset, retry]) control.disabled = disabled;
    email.disabled = disabled;
    password.disabled = disabled;
    page.setAttribute('aria-busy', String(disabled));
    form.hidden = !!session.uid;
    google.hidden = !!session.uid;
    toggle.hidden = !!session.uid;
    reset.hidden = !!session.uid;
  }
  const unsubscribe = session.subscribe(sync);
  async function bootstrap() {
    const uid = session.uid;
    try {
      await session.bootstrap();
      if (active && uid && session.uid === uid) complete();
    } catch {
      if (active && session.uid === uid) {
        status.textContent = t('auth.accountUnavailable');
        retry.hidden = false;
      }
    }
  }
  async function run(action: () => Promise<unknown>, success: () => void | Promise<void> = bootstrap) {
    if (busy || session.busy || !initialized) return;
    busy = true;
    status.textContent = t('auth.working');
    sync();
    try {
      await action();
      password.value = '';
      if (active) await success();
    } catch (error) {
      if (active) status.textContent = t(authErrorMessage(error));
    } finally {
      busy = false;
      if (active) sync();
    }
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    void run(() => creating ? session.createAccount(email.value.trim(), password.value)
      : session.signInEmail(email.value.trim(), password.value));
  });
  google.addEventListener('click', () => { void run(() => session.signInGoogle()); });
  toggle.addEventListener('click', () => {
    creating = !creating;
    password.value = '';
    password.autocomplete = creating ? 'new-password' : 'current-password';
    submit.textContent = t(creating ? 'auth.createAccount' : 'auth.signIn');
    toggle.textContent = t(creating ? 'auth.haveAccount' : 'auth.createAccount');
  });
  reset.addEventListener('click', () => {
    if (email.reportValidity()) void run(() => session.resetPassword(email.value.trim()), () => {
      status.textContent = t('auth.resetSent');
    });
  });
  retry.addEventListener('click', () => { void run(bootstrap, () => {}); });
  back.addEventListener('click', () => {
    void session.signOut().then(cancel, () => { status.textContent = t('auth.signInError'); });
  });
  sync();
  void session.ready.then(() => {
    if (!active) return;
    initialized = true;
    sync();
    if (session.uid) void run(bootstrap, () => {});
  }).catch(() => { if (active) status.textContent = t('auth.signInError'); });
  return {
    element: page,
    dispose() { active = false; password.value = ''; unsubscribe(); },
  };
}
