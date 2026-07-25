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
      sb.auth.onAuthStateChange(async (_event, session) => {
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

    async sendPhoneOtp(phoneE164) {
      const { error } = await sb.auth.signInWithOtp({ phone: phoneE164 });
      if (error) throw error;
    },

    async sendMagicLink(email) {
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.href.split('#')[0], shouldCreateUser: true }
      });
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
          document.getElementById('naAcctBtn').onclick = (e) => {
            e.stopPropagation();
            const menu = document.getElementById('naAcctMenu');
            menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
          };
          document.addEventListener('click', () => { const m = document.getElementById('naAcctMenu'); if (m) m.style.display = 'none'; }, { once: true });
          document.getElementById('naSignOutLink').onclick = (e) => { e.preventDefault(); this.signOut(); };
          document.getElementById('naFavLink').onclick = (e) => { e.preventDefault(); if (typeof window.naOpenFavorites === 'function') window.naOpenFavorites(); };
          document.getElementById('naListingsLink').onclick = (e) => { e.preventDefault(); if (typeof window.naOpenMyListings === 'function') window.naOpenMyListings(); else window.location.href = 'list-property.html#my-listings'; };
        } else {
          el.innerHTML = `<button onclick="NaijaAuth.openLoginModal()" style="background:none;border:0.5px solid #ddd;border-radius:20px;padding:6px 14px;cursor:pointer;font-size:12.5px;color:#1a1a1a">Sign in</button>`;
        }
      };
      render();
      this.onChange(render);
    }
  };

  function injectModal() {
    if (document.getElementById('naAuthModal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'naAuthModal';
    wrap.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:999;align-items:center;justify-content:center;padding:1rem';
    wrap.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:1.75rem;max-width:340px;width:100%;text-align:center;font-family:inherit">
        <div style="font-size:16px;font-weight:600;margin-bottom:4px;color:#1a1a1a">Sign in to NaijaNest</div>
        <div style="font-size:12.5px;color:#666;margin-bottom:18px">Save favorites, track your listings, and pick up your chat where you left off.</div>

        <button id="naGoogleBtn" style="width:100%;padding:11px;border-radius:8px;border:1px solid #ddd;background:#fff;font-size:13.5px;font-weight:500;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:12px;color:#1a1a1a">
          <svg width="16" height="16" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.5 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.5 29.6 4 24 4c-7.5 0-14 4.2-17.7 10.7z"/><path fill="#4CAF50" d="M24 44c5.5 0 10.5-2.1 14.2-5.6l-6.6-5.4C29.6 34.7 26.9 36 24 36c-5.3 0-9.6-3.3-11.3-7.9l-6.6 5C9.9 39.7 16.4 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.2 5.6l6.6 5.4C41.4 36.4 44 30.7 44 24c0-1.3-.1-2.7-.4-3.5z"/></svg>
          Continue with Google
        </button>

        <div style="font-size:11px;color:#999;margin:10px 0">— or —</div>

        <div id="naEmailStep1">
          <input id="naEmailInput" type="email" placeholder="you@example.com" style="width:100%;height:42px;border:1px solid #ddd;border-radius:8px;padding:0 12px;font-size:13.5px;margin-bottom:10px;outline:none;box-sizing:border-box"/>
          <button id="naSendLinkBtn" style="width:100%;padding:11px;border-radius:8px;border:none;background:#1a6b3a;color:#fff;font-size:13.5px;font-weight:500;cursor:pointer">Email me a verification link</button>
        </div>
        <div id="naEmailSent" style="display:none;padding:8px 0">
          <div style="font-size:28px;margin-bottom:6px">📧</div>
          <div style="font-size:13px;color:#1a1a1a;font-weight:500;margin-bottom:4px">Check your email</div>
          <div style="font-size:12px;color:#666">We sent a verification link to <span id="naEmailSentAddr" style="font-weight:500"></span>. Click it to sign in — this window will update automatically.</div>
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

    document.getElementById('naSendLinkBtn').onclick = async () => {
      const email = document.getElementById('naEmailInput').value.trim();
      if (!email || !email.includes('@')) return showAuthError('Enter a valid email address');
      const btn = document.getElementById('naSendLinkBtn');
      btn.disabled = true; btn.textContent = 'Sending...';
      try {
        await NaijaAuth.sendMagicLink(email);
        document.getElementById('naEmailStep1').style.display = 'none';
        document.getElementById('naEmailSentAddr').textContent = email;
        document.getElementById('naEmailSent').style.display = 'block';
        hideAuthError();
      } catch (e) {
        showAuthError(e.message || 'Could not send verification link');
      }
      btn.disabled = false; btn.textContent = 'Email me a verification link';
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

  function showAuthError(msg) {
    const el = document.getElementById('naAuthError');
    el.textContent = msg; el.style.display = 'block';
  }
  function hideAuthError() {
    document.getElementById('naAuthError').style.display = 'none';
  }
  function openLoginModal() {
    injectModal();
    document.getElementById('naEmailStep1').style.display = 'block';
    document.getElementById('naEmailSent').style.display = 'none';
    document.getElementById('naEmailInput').value = '';
    document.getElementById('naPhoneStep1').style.display = PHONE_AUTH_ENABLED ? 'block' : 'none';
    document.getElementById('naPhoneStep2').style.display = 'none';
    document.getElementById('naAuthModal').style.display = 'flex';
  }
  function closeModal() {
    const el = document.getElementById('naAuthModal');
    if (el) el.style.display = 'none';
  }

  window.NaijaAuth = NaijaAuth;
  NaijaAuth.init();
})();
