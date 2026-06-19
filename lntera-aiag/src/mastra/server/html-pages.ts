const SHARED_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

body{
  font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  background:#fff;
  color:#111;
  min-height:100vh;
  display:flex;
  align-items:flex-start;
  justify-content:center;
  padding:64px 24px 96px;
  -webkit-font-smoothing:antialiased;
}

.page{width:100%;max-width:480px}

/* ── Logo ── */
.logo{
  display:flex;
  align-items:center;
  gap:8px;
  margin-bottom:56px;
  text-decoration:none;
  color:#111;
}
.logo-mark{
  width:28px;height:28px;
  background:#dc4a1e;
  border-radius:7px;
  display:flex;align-items:center;justify-content:center;
  flex-shrink:0;
}
.logo-mark svg{display:block}
.logo-name{
  font-size:14px;
  font-weight:600;
  letter-spacing:-.01em;
  color:#111;
}

/* ── Platform label ── */
.platform-label{
  font-size:11px;
  font-weight:500;
  letter-spacing:.08em;
  text-transform:uppercase;
  color:#999;
  font-family:'SF Mono','Fira Code',ui-monospace,monospace;
  margin-bottom:12px;
}

/* ── Status badge ── */
.status-badge{
  display:inline-flex;
  align-items:center;
  gap:7px;
  padding:5px 12px 5px 8px;
  border-radius:100px;
  font-size:12px;
  font-weight:500;
  letter-spacing:.01em;
  margin-bottom:20px;
}
.badge-dot{
  width:6px;height:6px;
  border-radius:50%;
  background:currentColor;
  flex-shrink:0;
}
.status-success{background:#f0faf4;color:#0d6b2e;border:1px solid #b6e8cb}
.status-error{background:#fef5f5;color:#b80b0b;border:1px solid #f5c0c0}
.status-active{background:#f0faf4;color:#0d6b2e;border:1px solid #b6e8cb}

/* ── Headings ── */
h1{
  font-size:28px;
  font-weight:600;
  letter-spacing:-.04em;
  line-height:1.15;
  color:#111;
  margin-bottom:10px;
}
.subtitle{
  font-size:15px;
  color:#555;
  line-height:1.55;
  margin-bottom:32px;
}
.subtitle strong{color:#111;font-weight:500}

/* ── Info table ── */
.info-table{
  border-top:1px solid #e5e5e5;
  margin:28px 0 32px;
}
.info-row{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:16px;
  padding:13px 0;
  border-bottom:1px solid #e5e5e5;
  font-size:14px;
}
.info-label{color:#666;flex-shrink:0}
.info-value{
  font-family:'SF Mono','Fira Code',ui-monospace,monospace;
  font-size:12px;
  background:#f3f3f3;
  color:#111;
  padding:3px 8px;
  border-radius:4px;
  max-width:280px;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  text-align:right;
}

/* ── Close hint ── */
.close-hint{
  font-size:13px;
  color:#999;
  line-height:1.5;
  margin-top:36px;
}

/* ── Hint text ── */
.hint-text{
  font-size:13px;
  color:#666;
  line-height:1.5;
  margin-bottom:0;
}

/* ── Divider ── */
.divider{border:none;border-top:1px solid #e5e5e5;margin:28px 0}

/* ── Steps ── */
.steps{list-style:none;margin:24px 0 32px;display:flex;flex-direction:column;gap:20px}
.step{display:flex;gap:14px;align-items:flex-start}
.step-num{
  flex-shrink:0;
  width:24px;height:24px;
  background:#dc4a1e;color:#fff;
  border-radius:50%;
  font-size:11px;font-weight:600;
  display:flex;align-items:center;justify-content:center;
  margin-top:1px;
}
.step-body{font-size:14px;line-height:1.5;display:flex;flex-direction:column;gap:6px;padding-top:2px}
.step-body strong{font-weight:500;color:#111;display:block}
.step-hint{font-size:13px;color:#666}

/* ── Form ── */
.form-field{margin-bottom:16px}
label{
  display:block;
  font-size:13px;
  font-weight:500;
  color:#111;
  margin-bottom:7px;
}
input[type=text],input[type=email],input[type=password],textarea{
  width:100%;
  padding:11px 13px;
  font-size:15px;
  font-family:inherit;
  border:1px solid #e5e5e5;
  border-radius:8px;
  background:#fff;
  color:#111;
  outline:none;
  transition:border-color .15s,box-shadow .15s;
  appearance:none;
}
input[type=text]:focus,input[type=email]:focus,input[type=password]:focus,textarea:focus{
  border-color:#dc4a1e;
  box-shadow:0 0 0 3px rgba(220,74,30,.14);
}
input::placeholder,textarea::placeholder{color:#bbb}

/* ── Segmented control (tabs) ── */
.seg{
  display:flex;
  gap:4px;
  padding:4px;
  margin-bottom:24px;
  background:#f3f3f3;
  border:1px solid #e5e5e5;
  border-radius:10px;
}
.seg button{
  flex:1;
  border:none;
  background:transparent;
  padding:9px 12px;
  border-radius:7px;
  font-family:inherit;
  font-size:14px;
  font-weight:500;
  color:#666;
  cursor:pointer;
  transition:background .15s,color .15s,box-shadow .15s;
}
.seg button.active{background:#fff;color:#111;box-shadow:0 1px 2px rgba(0,0,0,.08)}

/* ── "OR" divider ── */
.divider-or{
  display:flex;
  align-items:center;
  gap:12px;
  margin:22px 0;
  color:#999;
  font-size:12px;
  letter-spacing:.04em;
}
.divider-or::before,.divider-or::after{content:"";flex:1;height:1px;background:#e5e5e5}

/* ── Token box ── */
.token-box{
  font-family:'SF Mono','Fira Code',ui-monospace,monospace;
  font-size:11px;
  line-height:1.5;
  background:#f9f9f9;
  resize:vertical;
  word-break:break-all;
}

/* ── Buttons ── */
.btn{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:6px;
  padding:10px 18px;
  border-radius:8px;
  border:1px solid transparent;
  font-size:14px;
  font-weight:500;
  font-family:inherit;
  cursor:pointer;
  text-decoration:none;
  transition:opacity .12s,background .12s;
  white-space:nowrap;
}
.btn:disabled{opacity:.38;cursor:not-allowed}
.btn:not(:disabled):hover{opacity:.82}
.btn-primary{background:#dc4a1e;color:#fff;border-color:#dc4a1e}
.btn-secondary{background:#fff;color:#111;border-color:#e5e5e5}
.btn-secondary:not(:disabled):hover{background:#f9f9f9;opacity:1}
.btn-block{width:100%;padding:12px 18px;font-size:15px}

.btn-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}

/* ── Alert / status ── */
.alert{
  border-radius:8px;
  padding:13px 15px;
  font-size:14px;
  line-height:1.5;
  margin-top:16px;
}
.alert-error{background:#fef5f5;border:1px solid #f5c0c0;color:#b80b0b}
.alert-success{background:#f0faf4;border:1px solid #b6e8cb;color:#0d6b2e}
.alert-neutral{background:#f9f9f9;border:1px solid #e5e5e5;color:#444}

/* ── Code inline ── */
code{
  background:#f3f3f3;
  padding:2px 6px;
  border-radius:4px;
  font-family:'SF Mono','Fira Code',ui-monospace,monospace;
  font-size:.85em;
  color:#111;
}
`;

export function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)} — Lntera</title>
<link rel="icon" href="data:,">
<style>${SHARED_CSS}</style>
</head>
<body>
<div class="page">
${body}
</div>
</body>
</html>`;
}

function logoHtml(): string {
  // Matches the web BrandMark: orange tile + white monoline "L" + AI spark.
  return `<div class="logo">
  <div class="logo-mark">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M9 6.25V13.5a2.5 2.5 0 0 0 2.5 2.5H15.5" stroke="#fff" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M17 4.4C17.2 6.05 17.55 6.55 19.2 6.8C17.55 7.05 17.2 7.55 17 9.2C16.8 7.55 16.45 7.05 14.8 6.8C16.45 6.55 16.8 6.05 17 4.4Z" fill="#fff" fill-opacity="0.9"/>
    </svg>
  </div>
  <span class="logo-name">Lntera</span>
</div>`;
}

function escHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function oauthErrorPage(args: {
  platform: string;
  title: string;
  message: string;
  hint?: string;
}): string {
  const hint = args.hint
    ? `<p class="hint-text" style="margin-top:16px">${escHtml(args.hint)}</p>`
    : '';
  return htmlPage(
    args.title,
    `${logoHtml()}
<p class="platform-label">${escHtml(args.platform)} OAuth</p>
<div class="status-badge status-error"><span class="badge-dot"></span>Failed</div>
<h1>${escHtml(args.title)}</h1>
<p class="subtitle">${escHtml(args.message)}</p>${hint}`,
  );
}

export function groqAlreadyConnectedPage(args: {
  tenantName: string;
  tenantSlug: string;
}): string {
  return htmlPage(
    'Groq connected',
    `${logoHtml()}
<div class="status-badge status-active"><span class="badge-dot"></span>Active</div>
<h1>Groq is connected</h1>
<p class="subtitle">Workspace <strong>${escHtml(args.tenantName)}</strong> (<code>${escHtml(args.tenantSlug)}</code>) already has an active Groq key provisioned via Portkey.</p>
<p class="close-hint">You can close this page and return to Discord.</p>`,
  );
}

export function groqOnboardFormPage(args: {
  tenantName: string;
  tenantSlug: string;
  tenantId: string;
  token: string;
}): string {
  const tenantIdJson = JSON.stringify(args.tenantId);
  const tokenJson = JSON.stringify(args.token);
  const body = `${logoHtml()}
<h1>Connect Groq</h1>
<p class="subtitle">Workspace <strong>${escHtml(args.tenantName)}</strong> &middot; <code>${escHtml(args.tenantSlug)}</code></p>
<p class="hint-text">Your key is stored securely via Portkey &mdash; we never save it in our database.</p>
<hr class="divider">
<ol class="steps">
  <li class="step">
    <span class="step-num">1</span>
    <div class="step-body">
      <strong>Create a Groq API key</strong>
      <div><button type="button" class="btn btn-secondary" id="openGroq" style="margin-top:6px">Open Groq console &nearr;</button></div>
    </div>
  </li>
  <li class="step">
    <span class="step-num">2</span>
    <div class="step-body">
      <strong>Copy the key</strong>
      <span class="step-hint">Keys start with <code>gsk_</code></span>
    </div>
  </li>
  <li class="step">
    <span class="step-num">3</span>
    <div class="step-body">
      <strong>Paste it below</strong>
      <span class="step-hint">We detect clipboard paste automatically.</span>
    </div>
  </li>
</ol>
<form id="groqForm">
  <div class="form-field">
    <label for="groqKey">Groq API key</label>
    <input type="password" id="groqKey" name="groqKey" autocomplete="off" placeholder="gsk_..." required>
  </div>
  <div class="btn-row" style="margin-bottom:20px">
    <button type="button" class="btn btn-secondary" id="readClipboard">Paste from clipboard</button>
  </div>
  <button type="submit" class="btn btn-primary" id="submitBtn" style="width:100%;padding:13px 18px;font-size:15px">Connect Groq</button>
</form>
<div id="status"></div>
<script>
(function(){
  var tenantId=${tenantIdJson};
  var token=${tokenJson};
  var form=document.getElementById('groqForm');
  var keyInput=document.getElementById('groqKey');
  var statusEl=document.getElementById('status');
  var submitBtn=document.getElementById('submitBtn');

  function setStatus(html,cls){
    statusEl.innerHTML='<div class="alert '+cls+'">'+html+'</div>';
  }

  document.getElementById('openGroq').addEventListener('click',function(){
    window.open('https://console.groq.com/keys','_blank','noopener');
  });

  keyInput.addEventListener('paste',function(e){
    var text=(e.clipboardData||window.clipboardData).getData('text');
    if(text&&text.trim().startsWith('gsk_')){
      setTimeout(function(){keyInput.value=text.trim();},0);
    }
  });

  document.getElementById('readClipboard').addEventListener('click',async function(){
    try{
      var text=await navigator.clipboard.readText();
      if(text&&text.trim().startsWith('gsk_')){
        keyInput.value=text.trim();
        setStatus('Pasted from clipboard.','alert-neutral');
      }else{
        setStatus('Clipboard does not contain a Groq key (expected gsk_...).','alert-error');
      }
    }catch(err){
      setStatus('Could not read clipboard. Paste manually (Cmd/Ctrl+V) or allow clipboard permission.','alert-error');
    }
  });

  form.addEventListener('submit',async function(e){
    e.preventDefault();
    var groqApiKey=keyInput.value.trim();
    if(!groqApiKey.startsWith('gsk_')){
      setStatus('Invalid key format. Groq keys start with gsk_.','alert-error');
      return;
    }
    submitBtn.disabled=true;
    setStatus('Connecting &mdash; provisioning and validating&hellip;','alert-neutral');
    try{
      var res=await fetch('/integrations/groq/onboard',{
        method:'POST',
        headers:{'Content-Type':'application/json','X-Groq-Onboard-Token':token},
        body:JSON.stringify({groqApiKey:groqApiKey,tenantId:tenantId,token:token})
      });
      var data=await res.json().catch(function(){return{};});
      if(!res.ok){throw new Error(data.message||data.error||'HTTP '+res.status);}
      setStatus('<strong>Connected!</strong> You can close this page and return to Discord.','alert-success');
      keyInput.value='';
    }catch(err){
      setStatus(String(err.message||err).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),'alert-error');
      submitBtn.disabled=false;
    }
  });
})();
</script>`;

  return htmlPage('Connect Groq', body);
}
