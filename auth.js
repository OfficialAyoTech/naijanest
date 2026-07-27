// ============================================================
// NaijaNest shared auth module
// Requires the Supabase JS SDK loaded BEFORE this script:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
//   <script src="/auth.js"></script>
// ============================================================
(function () {
  const SUPABASE_URL = 'https://ymojmrqdnnomgdclmnlz.supabase.co';
  // Anon key — safe to ship in client code by design (RLS enforces real security server-side)
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inltb2ptcnFkbm5vbWdkY2xtbmx6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2ODA2MjMsImV4cCI6MjA5ODI1NjYyM30.HefdVc5JC-1lONGDs6pKq2o5Iz2-L9Y_mtNrLIciKCk';
  // Flip to true once custom SMTP (Resend/SendGrid + a verified domain) is set up in Supabase.
  // Until then, real users won't receive confirmation/reset emails at all — so this stays off
  // and Google is the only sign-in method shown.
  const EMAIL_AUTH_ENABLED = false;
  // Flip to true once a phone/SMS provider is configured in Supabase Auth → Providers → Phone
  const PHONE_AUTH_ENABLED = false;

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const NaijaAuth = {
    client: sb,
    currentUser: null,
    currentProfile: null,
    _listeners: [],

    onChange(fn) { this._listeners.push(fn); },
    _notify() { this._listeners.forEach(fn => { try { fn(this.currentUser, this.currentProfile); } catch (e) {} }); },

    async init() {
      injectModal();
      const { data: { session } } = await sb.auth.getSession();
      this.currentUser = session ? session.user : null;
      if (this.currentUser) await this._ensureProfile();
      this._notify();
      sb.auth.onAuthStateChange(async (event, session) => {
        if (event === 'PASSWORD_RECOVERY') {
          openResetPasswordModal();
          return;
        }
        this.currentUser = session ? session.user : null;
        if (this.currentUser) await this._ensureProfile();
        else this.currentProfile = null;
        this._notify();
        closeModal();
      });
    },

    async _ensureProfile() {
      if (!this.currentUser) return;
      try {
        const { data } = await sb.from('profiles').select('*').eq('id', this.currentUser.id).maybeSingle();
        if (data) { this.currentProfile = data; return; }
        const name = this.currentUser.user_metadata?.full_name || this.currentUser.user_metadata?.name
          || this.currentUser.phone || this.currentUser.email || 'NaijaNest User';
        const { data: created } = await sb.from('profiles')
          .insert({ id: this.currentUser.id, name, role: 'renter' }).select().maybeSingle();
        this.currentProfile = created || { id: this.currentUser.id, name, role: 'renter' };
      } catch (e) { console.log('profile sync failed', e); }
    },

    async signInWithGoogle() {
      await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.href.split('#')[0] } });
    },

    // Creates the account and sends a one-time confirmation link to the user's email.
    // The account can't sign in with a password until that link is clicked.
    async signUpWithPassword(email, password) {
      const { data, error } = await sb.auth.signUp({
        email, password,
        options: { emailRedirectTo: window.location.href.split('#')[0] }
      });
      if (error) throw error;
      // If email confirmation is required, Supabase returns a user but no session yet.
      return { needsConfirmation: !data.session };
    },

    async signInWithPassword(email, password) {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },

    async sendPasswordReset(email) {
      const { error } = await sb.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.href.split('#')[0]
      });
      if (error) throw error;
    },

    async updatePassword(newPassword) {
      const { error } = await sb.auth.updateUser({ password: newPassword });
      if (error) throw error;
    },

    async sendPhoneOtp(phoneE164) {
      const { error } = await sb.auth.signInWithOtp({ phone: phoneE164 });
      if (error) throw error;
    },

    async verifyPhoneOtp(phoneE164, code) {
      const { error } = await sb.auth.verifyOtp({ phone: phoneE164, token: code, type: 'sms' });
      if (error) throw error;
    },

    async signOut() { await sb.auth.signOut(); },

    async getAccessToken() {
      const { data: { session } } = await sb.auth.getSession();
      return session ? session.access_token : null;
    },

    isLoggedIn() { return !!this.currentUser; },
    openLoginModal, closeModal,

    // Renders a "Sign in" button, or an avatar/menu if logged in, into the given element.
    renderAccountButton(el) {
      const render = () => {
        if (this.isLoggedIn()) {
          const name = (this.currentProfile && this.currentProfile.name) || 'Account';
          const initial = name.trim().charAt(0).toUpperCase() || 'N';
          el.innerHTML = `
            <div style="position:relative" id="naAcctWrap">
              <button id="naAcctBtn" style="display:flex;align-items:center;gap:6px;background:none;border:0.5px solid #ddd;border-radius:20px;padding:5px 10px 5px 5px;cursor:pointer;font-size:12.5px;color:#1a1a1a">
                <span style="width:22px;height:22px;border-radius:50%;background:#1a6b3a;color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600">${initial}</span>
                ${name.split(' ')[0]}
              </button>
              <div id="naAcctMenu" style="display:none;position:absolute;right:0;top:36px;background:#fff;border:0.5px solid #ddd;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,0.1);min-width:160px;z-index:200;overflow:hidden">
                <a href="#" id="naFavLink" style="display:block;padding:10px 14px;font-size:13px;color:#1a1a1a;text-decoration:none;border-bottom:0.5px solid #eee">❤️ My Favorites</a>
                <a href="#" id="naListingsLink" style="display:block;padding:10px 14px;font-size:13px;color:#1a1a1a;text-decoration:none;border-bottom:0.5px solid #eee">🏠 My Listings</a>
                <a href="#" id="naSignOutLink" style="display:block;padding:10px 14px;font-size:13px;color:#dc2626;text-decoration:none">Sign out</a>
              </div>
            </div>`;
          el.querySelector('#naAcctBtn').onclick = (e) => {
            e.stopPropagation();
            const menu = el.querySelector('#naAcctMenu');
            menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
          };
          document.addEventListener('click', () => { const m = el.querySelector('#naAcctMenu'); if (m) m.style.display = 'none'; });
          el.querySelector('#naSignOutLink').onclick = (e) => { e.preventDefault(); this.signOut(); };
          el.querySelector('#naFavLink').onclick = (e) => { e.preventDefault(); if (typeof window.naOpenFavorites === 'function') window.naOpenFavorites(); else window.location.href = 'index.html'; };
          el.querySelector('#naListingsLink').onclick = (e) => { e.preventDefault(); if (typeof window.naOpenMyListings === 'function') window.naOpenMyListings(); else window.location.href = 'my-listings.html'; };
        } else {
          el.innerHTML = `<button onclick="NaijaAuth.openLoginModal()" style="background:none;border:0.5px solid #ddd;border-radius:20px;padding:6px 14px;cursor:pointer;font-size:12.5px;color:#1a1a1a">Sign in</button>`;
        }
      };
      render();
      this.onChange(render);
    }
  };

  let mode = 'login'; // 'login' | 'signup' | 'forgot'

  function injectModal() {
    if (document.getElementById('naAuthModal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'naAuthModal';
    wrap.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:999;align-items:center;justify-content:center;padding:1rem';
    wrap.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:1.75rem;max-width:340px;width:100%;text-align:center;font-family:inherit">
        <div style="font-size:16px;font-weight:600;margin-bottom:4px;color:#1a1a1a" id="naModalTitle">Sign in to NaijaNest</div>
        <div style="font-size:12.5px;color:#666;margin-bottom:18px" id="naModalSub">Save favorites, track your listings, and pick up your chat where you left off.</div>

        <button id="naGoogleBtn" style="width:100%;padding:11px;border-radius:8px;border:1px solid #ddd;background:#fff;font-size:13.5px;font-weight:500;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:12px;color:#1a1a1a">
          <svg width="16" height="16" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.5 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.5 29.6 4 24 4c-7.5 0-14 4.2-17.7 10.7z"/><path fill="#4CAF50" d="M24 44c5.5 0 10.5-2.1 14.2-5.6l-6.6-5.4C29.6 34.7 26.9 36 24 36c-5.3 0-9.6-3.3-11.3-7.9l-6.6 5C9.9 39.7 16.4 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.2 5.6l6.6 5.4C41.4 36.4 44 30.7 44 24c0-1.3-.1-2.7-.4-3.5z"/></svg>
          Continue with Google
        </button>

        <div style="font-size:11px;color:#999;margin:10px 0;display:${EMAIL_AUTH_ENABLED ? 'block' : 'none'}">— or —</div>

        <div id="naAuthForm" style="display:${EMAIL_AUTH_ENABLED ? 'block' : 'none'}">
          <input id="naEmailInput" type="email" placeholder="you@example.com" style="width:100%;height:42px;border:1px solid #ddd;border-radius:8px;padding:0 12px;font-size:13.5px;margin-bottom:10px;outline:none;box-sizing:border-box"/>
          <input id="naPasswordInput" type="password" placeholder="Password (min 6 characters)" style="width:100%;height:42px;border:1px solid #ddd;border-radius:8px;padding:0 12px;font-size:13.5px;margin-bottom:10px;outline:none;box-sizing:border-box"/>
          <button id="naSubmitBtn" style="width:100%;padding:11px;border-radius:8px;border:none;background:#1a6b3a;color:#fff;font-size:13.5px;font-weight:500;cursor:pointer;margin-bottom:10px">Log in</button>
          <div style="font-size:12px;color:#666">
            <span id="naModeSwitchPrompt">New here?</span>
            <a href="#" id="naModeSwitchLink" style="color:#1a6b3a;font-weight:500;text-decoration:none">Create an account</a>
          </div>
          <div style="margin-top:8px">
            <a href="#" id="naForgotLink" style="font-size:12px;color:#999;text-decoration:none">Forgot password?</a>
          </div>
        </div>

        <div id="naCheckEmail" style="display:none;padding:8px 0">
          <div style="font-size:28px;margin-bottom:6px">📧</div>
          <div style="font-size:13px;color:#1a1a1a;font-weight:500;margin-bottom:4px" id="naCheckEmailTitle">Check your email</div>
          <div style="font-size:12px;color:#666" id="naCheckEmailBody"></div>
        </div>

        <div style="font-size:11px;color:#999;margin:10px 0;display:${PHONE_AUTH_ENABLED ? 'block' : 'none'}">— or —</div>

        <div id="naPhoneStep1" style="display:${PHONE_AUTH_ENABLED ? 'block' : 'none'}">
          <input id="naPhoneInput" type="tel" placeholder="080XXXXXXXX" style="width:100%;height:42px;border:1px solid #ddd;border-radius:8px;padding:0 12px;font-size:13.5px;margin-bottom:10px;outline:none;box-sizing:border-box"/>
          <button id="naSendOtpBtn" style="width:100%;padding:11px;border-radius:8px;border:none;background:#1a6b3a;color:#fff;font-size:13.5px;font-weight:500;cursor:pointer">Send code via SMS</button>
        </div>
        <div id="naPhoneStep2" style="display:none">
          <input id="naOtpInput" type="text" inputmode="numeric" placeholder="6-digit code" style="width:100%;height:42px;border:1px solid #ddd;border-radius:8px;padding:0 12px;font-size:13.5px;margin-bottom:10px;outline:none;box-sizing:border-box"/>
          <button id="naVerifyOtpBtn" style="width:100%;padding:11px;border-radius:8px;border:none;background:#1a6b3a;color:#fff;font-size:13.5px;font-weight:500;cursor:pointer">Verify code</button>
        </div>

        <div id="naAuthError" style="color:#dc2626;font-size:12px;margin-top:10px;display:none"></div>
        <button onclick="NaijaAuth.closeModal()" style="margin-top:16px;background:none;border:none;color:#666;font-size:12.5px;cursor:pointer">Cancel</button>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) closeModal(); });

    document.getElementById('naGoogleBtn').onclick = () => NaijaAuth.signInWithGoogle();

    document.getElementById('naModeSwitchLink').onclick = (e) => {
      e.preventDefault();
      mode = mode === 'login' ? 'signup' : 'login';
      renderAuthFormMode();
    };
    document.getElementById('naForgotLink').onclick = (e) => {
      e.preventDefault();
      mode = 'forgot';
      renderAuthFormMode();
    };

    document.getElementById('naSubmitBtn').onclick = async () => {
      const email = document.getElementById('naEmailInput').value.trim();
      const password = document.getElementById('naPasswordInput').value;
      if (!email || !email.includes('@')) return showAuthError('Enter a valid email address');
      const btn = document.getElementById('naSubmitBtn');

      if (mode === 'forgot') {
        btn.disabled = true; btn.textContent = 'Sending...';
        try {
          await NaijaAuth.sendPasswordReset(email);
          showCheckEmail('Check your email', `We sent a password reset link to <strong>${email}</strong>.`);
          hideAuthError();
        } catch (e) {
          showAuthError(e.message || 'Could not send reset link');
        }
        btn.disabled = false; btn.textContent = 'Send reset link';
        return;
      }

      if (!password || password.length < 6) return showAuthError('Password must be at least 6 characters');

      if (mode === 'signup') {
        btn.disabled = true; btn.textContent = 'Creating account...';
        try {
          const { needsConfirmation } = await NaijaAuth.signUpWithPassword(email, password);
          if (needsConfirmation) {
            showCheckEmail('Confirm your email', `We sent a verification link to <strong>${email}</strong>. Click it to activate your account, then come back and log in.`);
          }
          hideAuthError();
        } catch (e) {
          showAuthError(e.message || 'Could not create account');
        }
        btn.disabled = false; btn.textContent = 'Create account';
      } else {
        btn.disabled = true; btn.textContent = 'Logging in...';
        try {
          await NaijaAuth.signInWithPassword(email, password);
          hideAuthError();
        } catch (e) {
          showAuthError(e.message || 'Could not log in');
        }
        btn.disabled = false; btn.textContent = 'Log in';
      }
    };

    let pendingPhone = '';
    document.getElementById('naSendOtpBtn').onclick = async () => {
      const raw = document.getElementById('naPhoneInput').value.trim();
      const digits = raw.replace(/\D/g, '');
      const e164 = digits.startsWith('234') ? '+' + digits : digits.startsWith('0') ? '+234' + digits.slice(1) : '+' + digits;
      if (digits.length < 10) return showAuthError('Enter a valid phone number');
      const btn = document.getElementById('naSendOtpBtn');
      btn.disabled = true; btn.textContent = 'Sending...';
      try {
        pendingPhone = e164;
        await NaijaAuth.sendPhoneOtp(e164);
        document.getElementById('naPhoneStep1').style.display = 'none';
        document.getElementById('naPhoneStep2').style.display = 'block';
        hideAuthError();
      } catch (e) {
        showAuthError(e.message || 'Could not send code');
      }
      btn.disabled = false; btn.textContent = 'Send code via SMS';
    };

    document.getElementById('naVerifyOtpBtn').onclick = async () => {
      const code = document.getElementById('naOtpInput').value.trim();
      if (!code) return showAuthError('Enter the code sent to your phone');
      const btn = document.getElementById('naVerifyOtpBtn');
      btn.disabled = true; btn.textContent = 'Verifying...';
      try {
        await NaijaAuth.verifyPhoneOtp(pendingPhone, code);
        hideAuthError();
      } catch (e) {
        showAuthError(e.message || 'Invalid code');
      }
      btn.disabled = false; btn.textContent = 'Verify code';
    };
  }

  function renderAuthFormMode() {
    document.getElementById('naAuthForm').style.display = EMAIL_AUTH_ENABLED ? 'block' : 'none';
    document.getElementById('naCheckEmail').style.display = 'none';
    hideAuthError();
    const pwInput = document.getElementById('naPasswordInput');
    const submitBtn = document.getElementById('naSubmitBtn');
    const switchPrompt = document.getElementById('naModeSwitchPrompt');
    const switchLink = document.getElementById('naModeSwitchLink');
    const forgotLink = document.getElementById('naForgotLink');

    if (mode === 'login') {
      document.getElementById('naModalTitle').textContent = 'Log in to NaijaNest';
      pwInput.style.display = 'block';
      submitBtn.textContent = 'Log in';
      switchPrompt.textContent = 'New here?';
      switchLink.textContent = 'Create an account';
      forgotLink.style.display = 'block';
    } else if (mode === 'signup') {
      document.getElementById('naModalTitle').textContent = 'Create your NaijaNest account';
      pwInput.style.display = 'block';
      submitBtn.textContent = 'Create account';
      switchPrompt.textContent = 'Already have an account?';
      switchLink.textContent = 'Log in';
      forgotLink.style.display = 'none';
    } else if (mode === 'forgot') {
      document.getElementById('naModalTitle').textContent = 'Reset your password';
      pwInput.style.display = 'none';
      submitBtn.textContent = 'Send reset link';
      switchPrompt.textContent = 'Remembered it?';
      switchLink.textContent = 'Back to log in';
      forgotLink.style.display = 'none';
      switchLink.onclick = (e) => { e.preventDefault(); mode = 'login'; renderAuthFormMode(); };
    }
    if (mode !== 'forgot') {
      switchLink.onclick = (e) => { e.preventDefault(); mode = mode === 'login' ? 'signup' : 'login'; renderAuthFormMode(); };
    }
  }

  function showCheckEmail(title, bodyHtml) {
    document.getElementById('naAuthForm').style.display = 'none';
    document.getElementById('naCheckEmail').style.display = 'block';
    document.getElementById('naCheckEmailTitle').textContent = title;
    document.getElementById('naCheckEmailBody').innerHTML = bodyHtml;
  }

  function showAuthError(msg) {
    const el = document.getElementById('naAuthError');
    el.textContent = msg; el.style.display = 'block';
  }
  function hideAuthError() {
    document.getElementById('naAuthError').style.display = 'none';
  }
  function openLoginModal() {
    injectModal();
    mode = 'login';
    document.getElementById('naEmailInput').value = '';
    document.getElementById('naPasswordInput').value = '';
    renderAuthFormMode();
    document.getElementById('naPhoneStep1').style.display = PHONE_AUTH_ENABLED ? 'block' : 'none';
    document.getElementById('naPhoneStep2').style.display = 'none';
    document.getElementById('naAuthModal').style.display = 'flex';
  }
  function closeModal() {
    const el = document.getElementById('naAuthModal');
    if (el) el.style.display = 'none';
  }

  // Shown when the user arrives via a "reset password" email link.
  function openResetPasswordModal() {
    if (document.getElementById('naResetModal')) {
      document.getElementById('naResetModal').style.display = 'flex';
      return;
    }
    const wrap = document.createElement('div');
    wrap.id = 'naResetModal';
    wrap.style.cssText = 'display:flex;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:center;justify-content:center;padding:1rem';
    wrap.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:1.75rem;max-width:340px;width:100%;text-align:center;font-family:inherit">
        <div style="font-size:16px;font-weight:600;margin-bottom:4px;color:#1a1a1a">Set a new password</div>
        <div style="font-size:12.5px;color:#666;margin-bottom:16px">Choose a new password for your account.</div>
        <input id="naNewPasswordInput" type="password" placeholder="New password (min 6 characters)" style="width:100%;height:42px;border:1px solid #ddd;border-radius:8px;padding:0 12px;font-size:13.5px;margin-bottom:12px;outline:none;box-sizing:border-box"/>
        <button id="naNewPasswordBtn" style="width:100%;padding:11px;border-radius:8px;border:none;background:#1a6b3a;color:#fff;font-size:13.5px;font-weight:500;cursor:pointer">Update password</button>
        <div id="naResetError" style="color:#dc2626;font-size:12px;margin-top:10px;display:none"></div>
        <div id="naResetSuccess" style="color:#16a34a;font-size:12.5px;margin-top:10px;display:none">✅ Password updated — you're signed in.</div>
      </div>`;
    document.body.appendChild(wrap);
    document.getElementById('naNewPasswordBtn').onclick = async () => {
      const pw = document.getElementById('naNewPasswordInput').value;
      const errEl = document.getElementById('naResetError');
      if (!pw || pw.length < 6) { errEl.textContent = 'Password must be at least 6 characters'; errEl.style.display = 'block'; return; }
      const btn = document.getElementById('naNewPasswordBtn');
      btn.disabled = true; btn.textContent = 'Updating...';
      try {
        await NaijaAuth.updatePassword(pw);
        errEl.style.display = 'none';
        document.getElementById('naNewPasswordInput').style.display = 'none';
        btn.style.display = 'none';
        document.getElementById('naResetSuccess').style.display = 'block';
        setTimeout(() => { wrap.style.display = 'none'; }, 1800);
      } catch (e) {
        errEl.textContent = e.message || 'Could not update password';
        errEl.style.display = 'block';
      }
      btn.disabled = false; btn.textContent = 'Update password';
    };
  }

  window.NaijaAuth = NaijaAuth;
  function startInit() { NaijaAuth.init(); }
  if (document.body) startInit();
  else document.addEventListener('DOMContentLoaded', startInit);
})();
