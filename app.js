// Invest App - single file JS (offline, localStorage)
// Dados: transactions[], prices{asset:price}, goals{equity}, budgets{YYYY-MM:amount}, targets{asset:pct}

const LS_KEY = "invest_app_v1";

const $ = (id) => document.getElementById(id);
const fmtBRL = (v) =>
  (v || v === 0)
    ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v)
    : "—";
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const todayISO = () => new Date().toISOString().slice(0, 10);

const TYPE_LABEL = {
  deposit: "Depósito",
  withdraw: "Saque",
  buy: "Compra",
  sell: "Venda",
  dividend: "Dividendo",
  fee: "Taxa",
};

let state = loadState();
let editingId = null;

// --------------------------- State I/O ---------------------------
function defaultState() {
  return {
    cash: 0,
    transactions: [],
    prices: {},
    goals: { equity: null },
    budgets: {}, // key: YYYY-MM => number
    targets: {}, // asset => pct
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaultState();
    const s = JSON.parse(raw);
    return { ...defaultState(), ...s };
  } catch {
    return defaultState();
  }
}

function saveState() {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}

// --------------------------- Domain logic ---------------------------
function normalizeAsset(a) {
  return (a || "").trim().toUpperCase();
}

function txTotal(tx) {
  // Total financeiro que impacta o caixa (sinal tratado pelo tipo)
  const qty = Number(tx.qty || 0);
  const price = Number(tx.price || 0);
  const fees = Number(tx.fees || 0);

  if (tx.type === "deposit") return +Math.abs(price || tx.amount || 0);
  if (tx.type === "withdraw") return -Math.abs(price || tx.amount || 0);
  if (tx.type === "dividend") return +Math.abs(price || tx.amount || 0);
  if (tx.type === "fee") return -Math.abs(price || tx.amount || 0);

  // buy/sell: usa qty*price e ajusta fees
  const gross = qty * price;
  if (tx.type === "buy") return -(gross + fees);
  if (tx.type === "sell") return +(gross - fees);

  return 0;
}

function applyTransactionToCash(tx, sign = 1) {
  // sign=1 aplica, sign=-1 reverte
  state.cash += sign * txTotal(tx);
}

function rebuildCashFromTransactions() {
  state.cash = 0;
  const txs = [...state.transactions].sort((a,b) => (a.date < b.date ? -1 : 1));
  for (const tx of txs) state.cash += txTotal(tx);
}

function portfolioFromTransactions(transactions) {
  // Retorna map asset => { qty, avgCost, costBasis, realizedPnL }
  const lots = {}; // asset => { qty, avgCost, costBasis, realizedPnL }

  const txs = [...transactions].sort((a,b) => (a.date < b.date ? -1 : 1));

  for (const tx of txs) {
    const asset = normalizeAsset(tx.asset);
    const qty = Number(tx.qty || 0);
    const price = Number(tx.price || 0);
    const fees = Number(tx.fees || 0);

    if (!asset) continue;
    if (!lots[asset]) lots[asset] = { qty: 0, avgCost: 0, costBasis: 0, realizedPnL: 0 };

    const p = lots[asset];

    if (tx.type === "buy") {
      const totalCost = qty * price + fees;
      p.costBasis += totalCost;
      p.qty += qty;
      p.avgCost = p.qty > 0 ? p.costBasis / p.qty : 0;
    }

    if (tx.type === "sell") {
      // Realizado = (provento da venda - fees) - (qty * avgCost)
      const proceeds = qty * price - fees;
      const costOut = qty * p.avgCost;

      p.realizedPnL += (proceeds - costOut);
      p.qty -= qty;
      p.costBasis -= costOut;
      if (p.qty < 1e-12) { p.qty = 0; p.costBasis = 0; }
      p.avgCost = p.qty > 0 ? p.costBasis / p.qty : 0;
    }
  }

  return lots;
}

function computeKPIs() {
  const port = portfolioFromTransactions(state.transactions);
  const assets = Object.keys(port);

  let investedValue = 0;   // mark-to-market
  let costBasis = 0;
  let realized = 0;

  for (const a of assets) {
    const { qty, costBasis: cb, realizedPnL } = port[a];
    const px = Number(state.prices[a] || 0);
    investedValue += qty * px;
    costBasis += cb;
    realized += realizedPnL;
  }

  const unreal = investedValue - costBasis;
  const equity = state.cash + investedValue;

  return { equity, cash: state.cash, unreal, realized, port };
}

function equitySeriesLastN(n = 90) {
  // Gera uma série diária (últimos N dias) aproximada:
  // equity(t) = cash(t) + sum(qty(t) * currentPrice)
  // usa preços atuais (manual), não históricos
  const now = new Date();
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    days.push(d);
  }

  const txs = [...state.transactions].sort((a,b) => (a.date < b.date ? -1 : 1));

  let cash = 0;
  const holdings = {}; // asset => qty

  let idx = 0;
  const series = [];

  for (const d of days) {
    const iso = d.toISOString().slice(0,10);

    while (idx < txs.length && txs[idx].date <= iso) {
      const tx = txs[idx];
      cash += txTotal(tx);

      const asset = normalizeAsset(tx.asset);
      if (asset) holdings[asset] = holdings[asset] || 0;

      if (tx.type === "buy") holdings[asset] += Number(tx.qty || 0);
      if (tx.type === "sell") holdings[asset] -= Number(tx.qty || 0);

      idx++;
    }

    let mv = 0;
    for (const [asset, qty] of Object.entries(holdings)) {
      const px = Number(state.prices[asset] || 0);
      mv += qty * px;
    }

    series.push({ date: iso, equity: cash + mv });
  }

  return series;
}

// --------------------------- Report logic ---------------------------
function monthKey(dateISO) {
  return (dateISO || "").slice(0, 7); // YYYY-MM
}

function monthlyReport(yyyyMM) {
  const txs = state.transactions.filter(tx => monthKey(tx.date) === yyyyMM);
  let deposits = 0, withdraws = 0, dividends = 0, fees = 0;
  let buys = 0, sells = 0;

  for (const tx of txs) {
    const total = txTotal(tx);
    if (tx.type === "deposit") deposits += total;
    if (tx.type === "withdraw") withdraws += -total; // total já é negativo
    if (tx.type === "dividend") dividends += total;
    if (tx.type === "fee") fees += -total; // total já é negativo
    if (tx.type === "buy") buys += -total; // total negativo
    if (tx.type === "sell") sells += total;
  }

  const netCashFlow = deposits + dividends - withdraws - fees - buys + sells;
  return { deposits, withdraws, dividends, fees, buys, sells, netCashFlow, count: txs.length };
}

function depositsInMonth(yyyyMM) {
  const txs = state.transactions.filter(tx => monthKey(tx.date) === yyyyMM && tx.type === "deposit");
  return txs.reduce((acc, tx) => acc + txTotal(tx), 0);
}

// --------------------------- Rebalance ---------------------------
function rebalanceSuggestions(kpis) {
  // Compara alvos (%) com alocação atual por market value
  const targets = state.targets || {};
  const port = kpis.port;
  const assets = Object.keys(port);

  let totalMV = 0;
  const mvByAsset = {};
  for (const a of assets) {
    const mv = port[a].qty * Number(state.prices[a] || 0);
    mvByAsset[a] = mv;
    totalMV += mv;
  }

  const lines = [];
  const targetAssets = Object.keys(targets).map(normalizeAsset).filter(Boolean);

  if (targetAssets.length === 0) return { lines: [], note: "Defina alvos (%) para ver sugestões de rebalanceamento." };
  if (totalMV <= 0) return { lines: [], note: "Sem posição marcada a mercado (adicione compras e preços)." };

  for (const a of targetAssets) {
    const targetPct = Number(targets[a] || 0) / 100;
    const targetMV = totalMV * targetPct;
    const curMV = mvByAsset[a] || 0;
    const diff = targetMV - curMV; // positivo: falta (comprar), negativo: sobra (vender)

    lines.push({
      asset: a,
      targetPct: targetPct * 100,
      curPct: totalMV > 0 ? (curMV / totalMV) * 100 : 0,
      diff,
    });
  }

  lines.sort((x,y) => Math.abs(y.diff) - Math.abs(x.diff));
  return { lines, note: "Sugestões em R$ (aprox.) usando preços atuais." };
}

// --------------------------- UI rendering ---------------------------
function render() {
  saveState();

  const k = computeKPIs();
  $("kpiEquity").textContent = fmtBRL(k.equity);
  $("kpiCash").textContent = fmtBRL(k.cash);

  $("kpiUnreal").textContent = fmtBRL(k.unreal);
  $("kpiUnreal").className = "kpi-value " + (k.unreal >= 0 ? "good" : "bad");

  $("kpiReal").textContent = fmtBRL(k.realized);
  $("kpiReal").className = "kpi-value " + (k.realized >= 0 ? "good" : "bad");

  renderTransactions();
  renderPrices(k.port);
  renderGoal(k.equity);
  renderBudget();
  renderTargets();
  renderRebalance(k);
  drawEquityChart(equitySeriesLastN(120));
}

function renderTransactions() {
  const tbody = $("txTable").querySelector("tbody");
  tbody.innerHTML = "";

  const filtered = filterTransactions(state.transactions);
  $("txCount").textContent = String(filtered.length);

  for (const tx of filtered.sort((a,b)=> (a.date < b.date ? 1 : -1))) {
    const tr = document.createElement("tr");
    tr.dataset.id = tx.id;
    tr.innerHTML = `
      <td>${tx.date}</td>
      <td>${TYPE_LABEL[tx.type] || tx.type}</td>
      <td>${tx.asset || ""}</td>
      <td class="num">${Number(tx.qty||0) ? Number(tx.qty).toLocaleString("pt-BR") : ""}</td>
      <td class="num">${Number(tx.price||0) ? fmtBRL(Number(tx.price)) : ""}</td>
      <td class="num">${Number(tx.fees||0) ? fmtBRL(Number(tx.fees)) : ""}</td>
      <td class="num">${fmtBRL(txTotal(tx))}</td>
      <td>${escapeHtml(tx.note || "")}</td>
      <td class="num"><span class="trash" title="Remover">🗑️</span></td>
    `;

    tr.addEventListener("click", (e) => {
      if (e.target && e.target.classList.contains("trash")) return;
      startEditTx(tx.id);
    });

    tr.querySelector(".trash").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteTx(tx.id);
    });

    tbody.appendChild(tr);
  }
}

function renderPrices(port) {
  const box = $("pricesList");
  const assets = Object.keys(state.prices).sort();

  if (assets.length === 0) {
    box.innerHTML = `<div class="small">Sem preços salvos.</div>`;
    return;
  }

  box.innerHTML = "";
  for (const a of assets) {
    const px = Number(state.prices[a] || 0);
    const qty = port[a]?.qty || 0;
    const mv = qty * px;

    const div = document.createElement("div");
    div.className = "pill";
    div.innerHTML = `
      <div>
        <b>${a}</b>
        <span class="muted"> • Preço ${fmtBRL(px)} • Qtd ${qty ? qty.toLocaleString("pt-BR") : "0"} • MV ${fmtBRL(mv)}</span>
      </div>
      <button class="btn btn-ghost" data-asset="${a}">Remover</button>
    `;
    div.querySelector("button").addEventListener("click", () => {
      delete state.prices[a];
      render();
    });
    box.appendChild(div);
  }
}

function renderGoal(equity) {
  const goal = Number(state.goals?.equity || 0);
  const bar = $("goalBar");
  const txt = $("goalText");

  if (!goal || goal <= 0) {
    bar.style.width = "0%";
    txt.textContent = "Defina uma meta para ver o progresso.";
    return;
  }

  const pct = clamp((equity / goal) * 100, 0, 140);
  bar.style.width = pct + "%";
  txt.textContent = `${fmtBRL(equity)} de ${fmtBRL(goal)} (${pct.toFixed(1)}%).`;
}

function renderBudget() {
  const box = $("budgetText");
  const month = $("bMonth").value || monthKey(todayISO());
  const budget = Number(state.budgets?.[month] || 0);
  const deposited = depositsInMonth(month);

  if (!budget) {
    box.textContent = "Salve um orçamento e registre depósitos para acompanhar.";
    return;
  }

  const pct = clamp((deposited / budget) * 100, 0, 999);
  box.textContent = `Mês ${month}: Aportado ${fmtBRL(deposited)} de ${fmtBRL(budget)} (${pct.toFixed(1)}%).`;
}

function renderTargets() {
  const box = $("targetsList");
  const targets = state.targets || {};
  const assets = Object.keys(targets).sort();

  if (assets.length === 0) {
    box.innerHTML = `<div class="small">Sem alvos. Ex: IVVB11 = 25%</div>`;
    return;
  }

  box.innerHTML = "";
  for (const a of assets) {
    const pct = Number(targets[a] || 0);
    const div = document.createElement("div");
    div.className = "pill";
    div.innerHTML = `
      <div><b>${a}</b> <span class="muted">• Alvo ${pct.toFixed(2)}%</span></div>
      <button class="btn btn-ghost" data-asset="${a}">Remover</button>
    `;
    div.querySelector("button").addEventListener("click", () => {
      delete state.targets[a];
      render();
    });
    box.appendChild(div);
  }
}

function renderRebalance(kpis) {
  const box = $("rebalanceBox");
  const { lines, note } = rebalanceSuggestions(kpis);

  if (lines.length === 0) {
    box.innerHTML = `<div class="small">${note}</div>`;
    return;
  }

  const rows = lines.slice(0, 8).map(l => {
    const cls = l.diff >= 0 ? "good" : "bad";
    const action = l.diff >= 0 ? "Comprar ~" : "Vender ~";
    return `
      <div class="line">
        <span><b>${l.asset}</b> <span class="small">(${l.curPct.toFixed(1)}% → ${l.targetPct.toFixed(1)}%)</span></span>
        <span class="${cls}">${action}${fmtBRL(Math.abs(l.diff))}</span>
      </div>
    `;
  }).join("");

  box.innerHTML = `
    <div class="small">${note}</div>
    <div class="divider"></div>
    ${rows}
  `;
}

function renderReport(yyyyMM) {
  const r = monthlyReport(yyyyMM);
  const budget = Number(state.budgets?.[yyyyMM] || 0);
  const deposited = depositsInMonth(yyyyMM);

  const budgetLine = budget
    ? `<div class="line"><span>Orçamento (aporte)</span><span>${fmtBRL(budget)} • Aportado ${fmtBRL(deposited)}</span></div>`
    : `<div class="line"><span>Orçamento (aporte)</span><span class="muted">não definido</span></div>`;

  $("reportBox").innerHTML = `
    <div class="line"><span>Transações</span><span>${r.count}</span></div>
    <div class="divider"></div>

    <div class="line"><span>Depósitos</span><span class="good">${fmtBRL(r.deposits)}</span></div>
    <div class="line"><span>Dividendos</span><span class="good">${fmtBRL(r.dividends)}</span></div>
    <div class="line"><span>Saques</span><span class="bad">${fmtBRL(r.withdraws)}</span></div>
    <div class="line"><span>Taxas</span><span class="bad">${fmtBRL(r.fees)}</span></div>
    <div class="divider"></div>

    <div class="line"><span>Compras</span><span>${fmtBRL(r.buys)}</span></div>
    <div class="line"><span>Vendas</span><span>${fmtBRL(r.sells)}</span></div>
    <div class="divider"></div>

    ${budgetLine}
    <div class="divider"></div>

    <div class="line"><span><b>Resultado de caixa no mês</b></span><span><b>${fmtBRL(r.netCashFlow)}</b></span></div>
  `;
}

// --------------------------- Filters ---------------------------
function filterTransactions(txs) {
  const s = ($("qSearch").value || "").trim().toLowerCase();
  const m = $("qMonth").value || "";
  const t = $("qType").value || "";
  const a = normalizeAsset($("qAsset").value || "");

  return txs.filter(tx => {
    const hay = `${tx.type} ${tx.asset||""} ${tx.note||""}`.toLowerCase();
    const okS = !s || hay.includes(s);
    const okM = !m || monthKey(tx.date) === m;
    const okT = !t || tx.type === t;
    const okA = !a || normalizeAsset(tx.asset) === a;
    return okS && okM && okT && okA;
  });
}

// --------------------------- CRUD transactions ---------------------------
function newId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function addTx(tx) {
  state.transactions.push(tx);
  rebuildCashFromTransactions();
  render();
}

function updateTx(id, next) {
  const idx = state.transactions.findIndex(t => t.id === id);
  if (idx < 0) return;
  state.transactions[idx] = next;
  rebuildCashFromTransactions();
  render();
}

function deleteTx(id) {
  state.transactions = state.transactions.filter(t => t.id !== id);
  editingId = null;
  rebuildCashFromTransactions();
  clearForm();
  render();
}

function startEditTx(id) {
  const tx = state.transactions.find(t => t.id === id);
  if (!tx) return;
  editingId = id;

  $("txDate").value = tx.date;
  $("txType").value = tx.type;
  $("txAsset").value = tx.asset || "";
  $("txQty").value = tx.qty ?? "";
  $("txPrice").value = tx.price ?? "";
  $("txFees").value = tx.fees ?? 0;
  $("txNote").value = tx.note || "";

  // dica visual
  $("txForm").querySelector("button[type='submit']").textContent = "Salvar edição";
}

function clearForm() {
  editingId = null;
  $("txDate").value = todayISO();
  $("txType").value = "deposit";
  $("txAsset").value = "";
  $("txQty").value = "";
  $("txPrice").value = "";
  $("txFees").value = 0;
  $("txNote").value = "";
  $("txForm").querySelector("button[type='submit']").textContent = "Adicionar";
}

// --------------------------- Prices ---------------------------
function upsertPrice(asset, price) {
  const a = normalizeAsset(asset);
  if (!a) return;
  state.prices[a] = Number(price || 0);
  render();
}

// --------------------------- Export/Import ---------------------------
function exportJSON() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `invest-app-export-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result || "{}"));
      state = { ...defaultState(), ...data };
      rebuildCashFromTransactions();
      clearForm();
      render();
    } catch {
      alert("Arquivo inválido.");
    }
  };
  reader.readAsText(file);
}

function resetAll() {
  if (!confirm("Tem certeza? Isso apaga tudo.")) return;
  state = defaultState();
  saveState();
  clearForm();
  render();
}

// --------------------------- Chart ---------------------------
function drawEquityChart(series) {
  const canvas = $("equityChart");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;

  // clear
  ctx.clearRect(0,0,W,H);

  // padding
  const pad = 36;
  const x0 = pad, y0 = pad;
  const x1 = W - pad, y1 = H - pad;

  // bg grid
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;

  for (let i=0;i<=4;i++){
    const y = y0 + (i*(y1-y0)/4);
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
  }

  const vals = series.map(p => p.equity);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const span = (maxV - minV) || 1;

  function X(i){ return x0 + (i*(x1-x0)/(series.length-1)); }
  function Y(v){ return y1 - ((v - minV)/span)*(y1-y0); }

  // line
  ctx.strokeStyle = "rgba(98,160,255,0.95)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  series.forEach((p,i)=>{
    const x = X(i), y = Y(p.equity);
    if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();

  // labels
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = "12px system-ui";
  ctx.fillText(fmtBRL(maxV), 8, y0+4);
  ctx.fillText(fmtBRL(minV), 8, y1);

  const last = series[series.length-1];
  ctx.fillText(last.date, W - 90, H - 10);
}

// --------------------------- Utils ---------------------------
function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function parseTxFromForm() {
  const date = $("txDate").value;
  const type = $("txType").value;
  const asset = normalizeAsset($("txAsset").value);
  const qty = Number($("txQty").value || 0);
  const price = Number($("txPrice").value || 0);
  const fees = Number($("txFees").value || 0);
  const note = $("txNote").value || "";

  if (!date) throw new Error("Data inválida.");

  // Regras simples por tipo:
  if (["buy","sell"].includes(type)) {
    if (!asset) throw new Error("Ativo é obrigatório para compra/venda.");
    if (!(qty > 0)) throw new Error("Quantidade deve ser > 0.");
    if (!(price > 0)) throw new Error("Preço deve ser > 0.");
  }

  if (["deposit","withdraw","dividend","fee"].includes(type)) {
    // usa "price" como "amount" se qty=0 (mantemos compatibilidade)
    if (!(price > 0)) throw new Error("Valor (R$) deve ser > 0.");
  }

  return { date, type, asset: asset || "", qty, price, fees, note };
}

// --------------------------- Wire events ---------------------------
function init() {
  $("txDate").value = todayISO();

  $("txForm").addEventListener("submit", (e) => {
    e.preventDefault();
    try {
      const base = parseTxFromForm();
      const tx = { ...base, id: editingId || newId() };

      if (editingId) updateTx(editingId, tx);
      else addTx(tx);

      clearForm();
    } catch (err) {
      alert(String(err.message || err));
    }
  });

  $("btnClearForm").addEventListener("click", () => clearForm());

  // filtros
  ["qSearch","qMonth","qType","qAsset"].forEach(id => {
    $(id).addEventListener("input", renderTransactions);
    $(id).addEventListener("change", renderTransactions);
  });

  // preços
  $("priceForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const asset = $("pAsset").value;
    const price = $("pPrice").value;
    upsertPrice(asset, price);
    $("pAsset").value = "";
    $("pPrice").value = "";
  });

  // meta
  $("goalForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = Number($("gEquity").value || 0);
    state.goals.equity = v > 0 ? v : null;
    render();
  });

  // orçamento
  $("budgetForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const month = $("bMonth").value || monthKey(todayISO());
    const v = Number($("bMonthly").value || 0);
    if (v > 0) state.budgets[month] = v;
    else delete state.budgets[month];
    render();
  });

  $("bMonth").addEventListener("change", renderBudget);

  // targets
  $("targetForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const asset = normalizeAsset($("tAsset").value);
    const pct = Number($("tPct").value || 0);
    if (!asset) return alert("Ativo inválido.");
    if (!(pct > 0)) return alert("Alvo (%) deve ser > 0.");

    state.targets[asset] = pct;
    $("tAsset").value = "";
    $("tPct").value = "";
    render();
  });

  $("btnClearTargets").addEventListener("click", () => {
    state.targets = {};
    render();
  });

  // relatório
  $("reportMonth").value = monthKey(todayISO());
  $("btnRunReport").addEventListener("click", () => {
    const m = $("reportMonth").value;
    if (!m) return;
    renderReport(m);
  });

  // export/import/reset
  $("btnExport").addEventListener("click", exportJSON);
  $("importFile").addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) importJSON(f);
    e.target.value = "";
  });
  $("btnReset").addEventListener("click", resetAll);

  rebuildCashFromTransactions();
  clearForm();
  render();
  renderReport($("reportMonth").value);
}

init();