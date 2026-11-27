// =====================================================================
// MÃO NA MASSA - COMANDAS (versão online com Supabase)
// Este arquivo tem a lógica da tela. O dicionário de sabores está em
// sabores.js e os dados de conexão em config.js.
// =====================================================================

const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);


// =========================
// UTILIDADES
// =========================
const brl = n => Number(n || 0).toFixed(2).replace('.', ',');

// O "dia de trabalho" só vira às 5h da manhã (igual ao banco de dados),
// então as entregas depois da meia-noite contam na noite anterior.
function diaOperacional(d = new Date()) {
  const t = new Date(d.getTime() - 5 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(t);
}

function novoId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function lerLocal(chave) {
  try { return localStorage.getItem(chave); } catch (e) { return null; }
}
function gravarLocal(chave, valor) {
  try { localStorage.setItem(chave, valor); } catch (e) {}
}

let toastTimer = null;
function avisar(texto, erro = false) {
  const el = document.getElementById('toast');
  el.textContent = texto;
  el.classList.toggle('toast-erro', erro);
  el.classList.add('toast-visivel');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('toast-visivel'), 3500);
}

function indicador(estado) {
  const el = document.getElementById('estado-salvar');
  if (!el) return;
  const textos = { ok: '✔ Tudo salvo', salvando: '⏳ Salvando…', erro: '⚠ Sem conexão. Tentando de novo…' };
  el.textContent = textos[estado] || '';
  el.className = 'estado-salvar estado-' + estado;
}


// =========================
// ESTADO
// =========================
let usuario = null;          // { id, nome, papel }
let bairros = [];            // [{ id, nome, taxa }]
let entregadores = [];       // ['Fulano', ...]
let pedidos = [];            // abas abertas
let pedidoAtualId = null;
let aplicando = false;       // true enquanto a tela é preenchida por código

// Dados fixos de cada item do cardápio (preço e quantas esfihas conta)
const META = new Map();
document.querySelectorAll('.item').forEach(item => {
  META.set(item.dataset.nome, {
    preco: Number(item.dataset.preco || 0),
    esfiha: Number(item.dataset.esfiha || 0)
  });
});


// =========================
// SELEÇÃO DE ELEMENTOS
// =========================
const valorTotal = document.getElementById('valor-total');
const radiosTipo = document.querySelectorAll('input[name="tipo"]');
const entregaInfo = document.getElementById('entrega-info');
const bairroSelect = document.getElementById('bairro');
const botaoWhatsapp = document.getElementById('preencher-pedido');
const textoWhatsapp = document.getElementById('texto-whatsapp');
const botaoImprimir = document.getElementById('imprimir');
const previewConteudo = document.getElementById('preview-conteudo');
const entregadorInfo = document.getElementById('entregador-info');
const listaEntregadores = document.getElementById('lista-entregadores');
const listaAbas = document.getElementById('lista-abas-pedidos');
const campoCliente = document.getElementById('cliente');
const campoObs = document.getElementById('obs');


// =========================
// MOSTRAR ENTREGA
// =========================
radiosTipo.forEach(radio => {
  radio.addEventListener('change', () => {
    if (radio.checked && radio.value === 'entrega') {
      entregaInfo.classList.remove('hidden');
    } else {
      entregaInfo.classList.add('hidden');
      bairroSelect.value = '';
    }

    const ehEntrega = radio.checked && radio.value === 'entrega';
    entregadorInfo.classList.toggle('hidden', !ehEntrega);
    if (!ehEntrega) {
      document.querySelectorAll('input[name="entregador"]').forEach(r => { r.checked = false; });
    }

    calcularTotal();
    atualizarPreview();
  });
});


// =========================
// ITENS FIXOS
// =========================
document.querySelectorAll('.qtd-item').forEach(input => {
  input.addEventListener('input', () => {
    if (input.value < 0) input.value = 0;
    calcularTotal();
    atualizarPreview();
  });
});


// =========================
// TOTAL
// =========================
function taxaClienteSelecionada() {
  const op = bairroSelect.options[bairroSelect.selectedIndex];
  return Number(op?.dataset?.taxa || 0);
}

function totalNumero() {
  let total = 0;
  document.querySelectorAll('.item').forEach(item => {
    const preco = Number(item.dataset.preco || 0);
    const qtd = Number(item.querySelector('.qtd-item').value || 0);
    total += preco * qtd;
  });

  const tipo = document.querySelector('input[name="tipo"]:checked')?.value;
  if (tipo === 'entrega') total += taxaClienteSelecionada();

  return Math.round(total * 100) / 100;
}

function calcularTotal() {
  valorTotal.textContent = brl(totalNumero());
}


// =========================
// TEXTO DA COMANDA (prévia e impressão)
// =========================
function bairroPorId(id) {
  return bairros.find(b => b.id === Number(id));
}

function montarTexto(p) {
  let texto = '';
  texto += 'MÃO NA MASSA\n\n';
  texto += `CLIENTE: ${p.cliente}\n`;
  texto += `TIPO: ${p.tipo}\n\n`;
  texto += `PAGAMENTO: ${p.pagamento}\n\n`;

  if (p.tipo === 'entrega' && p.bairroId) {
    const b = bairroPorId(p.bairroId);
    if (b) texto += `BAIRRO: ${b.nome} - R$${brl(b.taxa)}\n`;
  }

  if (p.tipo === 'entrega' && p.entregador) {
    texto += `ENTREGADOR: ${p.entregador}\n`;
  }

  texto += '\n';

  let totalEsfihas = 0;
  META.forEach((meta, nome) => {
    const qtd = Number(p.quantidades[nome] || 0);
    if (qtd <= 0) return;
    texto += `${qtd}x ${nome}\n`;
    if (meta.esfiha > 0) totalEsfihas += qtd * meta.esfiha;
  });

  if (totalEsfihas > 0) texto += `\nTOTAL DE ESFIHAS: ${totalEsfihas}\n`;

  if ((p.obs || '').trim() !== '') texto += `\nOBS: ${p.obs.trim()}\n`;

  texto += `\nTOTAL: R$ ${brl(p.total)}`;
  return texto;
}

function atualizarPreview() {
  const dados = capturarPedido();
  dados.cliente = dados.cliente.trim();
  previewConteudo.textContent = montarTexto(dados);
  salvarPedidoAtual();
}


// =========================
// PREENCHER COMANDA (colar pedido do WhatsApp)
// =========================
botaoWhatsapp.addEventListener('click', () => {
  const avisoPreencher = document.getElementById('aviso-preencher');
  if (avisoPreencher) avisoPreencher.textContent = '';

  const texto = textoWhatsapp.value.toLowerCase().trim();
  if (!texto) return;

  document.querySelectorAll('.qtd-item').forEach(input => { input.value = 0; });

  const itensPorNome = new Map();
  document.querySelectorAll('.item').forEach(item => {
    itensPorNome.set(normalizarTexto(item.dataset.nome), item);
  });

  const naoReconhecidos = [];

  texto.split('\n').forEach(linha => {
    linha = linha.trim();
    if (!linha) return;

    const resultado = linha.match(/^(\d+)\s*x?\s*(.+)$/i);
    if (!resultado) return;

    const quantidade = Number(resultado[1]);
    const nomeOficial = encontrarNomeOficial(resultado[2]);
    const item = itensPorNome.get(normalizarTexto(nomeOficial));

    if (!item) {
      naoReconhecidos.push(linha);
      return;
    }

    const campo = item.querySelector('.qtd-item');
    campo.value = Number(campo.value || 0) + quantidade;
  });

  if (avisoPreencher && naoReconhecidos.length) {
    avisoPreencher.textContent = 'Não reconhecido (confira): ' + naoReconhecidos.join(' | ');
  }

  calcularTotal();
  atualizarPreview();
});


// =========================
// CAMPOS GERAIS
// =========================
campoCliente.addEventListener('input', atualizarPreview);
campoObs.addEventListener('input', atualizarPreview);

bairroSelect.addEventListener('change', () => {
  calcularTotal();
  atualizarPreview();
});

document.querySelectorAll('input[name="metodoPagamento"]').forEach(radio => {
  radio.addEventListener('change', atualizarPreview);
});


// =========================
// IMPRESSÃO
// =========================
const chkPcImpressora = document.getElementById('pc-impressora');
chkPcImpressora.checked = lerLocal('comandas_pc_impressora') === '1';
chkPcImpressora.addEventListener('change', () => {
  gravarLocal('comandas_pc_impressora', chkPcImpressora.checked ? '1' : '0');
  avisar(chkPcImpressora.checked
    ? 'Este computador vai imprimir os pedidos enviados pelos outros aparelhos.'
    : 'Este aparelho não imprime pedidos de outros aparelhos.');
});

function ehPcImpressora() {
  return chkPcImpressora.checked;
}

const HTML_IMPRESSAO = texto => `
  <html>
    <head>
      <title>Comanda</title>
      <style>
        body { font-family: Arial; padding: 10px; }
        pre { font-size: 24px; font-weight: bold; line-height: 1.5; white-space: pre-wrap; }
      </style>
    </head>
    <body>
      <pre>${escaparHtml(texto.toUpperCase())}</pre>
    </body>
  </html>`;

// Impressão manual (botão): igual ao sistema antigo
function imprimirJanela(texto) {
  const janela = window.open('', '', 'width=350,height=600');
  if (!janela) { avisar('O navegador bloqueou a janela de impressão. Permita pop-ups para este site.', true); return; }
  janela.document.write(HTML_IMPRESSAO(texto));
  janela.document.close();
  janela.focus();
  janela.print();
}

// Impressão automática (pedido vindo de outro aparelho): sem abrir janela
function imprimirIframe(texto) {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(f);
  const d = f.contentWindow.document;
  d.open();
  d.write(HTML_IMPRESSAO(texto));
  d.close();
  setTimeout(() => {
    f.contentWindow.focus();
    f.contentWindow.print();
    setTimeout(() => f.remove(), 3000);
  }, 250);
}

botaoImprimir.addEventListener('click', async () => {
  salvarPedidoAtual();
  const p = pedidos.find(x => x.id === pedidoAtualId);
  if (!p) return;

  const texto = previewConteudo.textContent;

  if (ehPcImpressora()) {
    imprimirJanela(texto);
    if (p.persistido || p._sujo) {
      if (await enfileirar(p)) {
        await sb.from('pedidos').update({ impresso_em: new Date().toISOString() }).eq('id', p.id);
      }
    }
    return;
  }

  // Outro aparelho: pede para o PC da impressora imprimir
  if (!p.persistido && !p._sujo) {
    avisar('Preencha o pedido antes de imprimir.', true);
    return;
  }
  if (!(await enfileirar(p))) {
    avisar('Não foi possível enviar. Verifique a internet.', true);
    return;
  }
  const { error } = await sb.from('pedidos')
    .update({ imprimir_solicitado_em: new Date().toISOString() })
    .eq('id', p.id);
  if (error) avisar('Não foi possível enviar para impressão.', true);
  else avisar('Pedido enviado para o PC da impressora.');
});

const jaImpressos = new Set();
async function verificarImpressaoRemota(r) {
  if (!ehPcImpressora() || !r.imprimir_solicitado_em) return;
  const pedido = new Date(r.imprimir_solicitado_em).getTime();
  const feito = r.impresso_em ? new Date(r.impresso_em).getTime() : 0;
  if (pedido <= feito) return;

  const chave = r.id + '|' + r.imprimir_solicitado_em;
  if (jaImpressos.has(chave)) return;
  jaImpressos.add(chave);

  const p = { ...deLinha(r) };
  p.cliente = (p.cliente || '').trim();
  imprimirIframe(montarTexto(p));
  avisar('Imprimindo pedido de ' + (p.cliente || 'sem nome') + '…');
  await sb.from('pedidos').update({ impresso_em: new Date().toISOString() }).eq('id', r.id);
}


// =========================
// PEDIDOS: tela <-> objeto <-> banco
// =========================
function pedidoVazio() {
  return {
    id: novoId(),
    persistido: false,
    numero: null,
    data: diaOperacional(),
    status: 'aberto',
    cliente: '',
    tipo: 'retirada',
    bairroId: null,
    pagamento: 'cartão',
    obs: '',
    textoWhatsapp: '',
    quantidades: {},
    entregador: '',
    total: 0
  };
}

// Lê o que está na tela
function capturarPedido() {
  const quantidades = {};
  document.querySelectorAll('.item').forEach(item => {
    const qtd = Number(item.querySelector('.qtd-item').value || 0);
    if (qtd > 0) quantidades[item.dataset.nome] = qtd;
  });

  const tipo = document.querySelector('input[name="tipo"]:checked')?.value || 'retirada';

  return {
    cliente: campoCliente.value,
    tipo,
    entregador: tipo === 'entrega'
      ? (document.querySelector('input[name="entregador"]:checked')?.value || '')
      : '',
    bairroId: tipo === 'entrega' ? (Number(bairroSelect.value) || null) : null,
    pagamento: document.querySelector('input[name="metodoPagamento"]:checked')?.value || 'cartão',
    obs: campoObs.value,
    textoWhatsapp: textoWhatsapp.value,
    quantidades,
    total: totalNumero()
  };
}

// Só os campos que vão para o banco (para comparar mudanças)
function camposGravaveis(p) {
  const q = {};
  Object.keys(p.quantidades || {}).sort().forEach(k => { q[k] = p.quantidades[k]; });
  return {
    cliente: p.cliente, tipo: p.tipo, bairroId: p.bairroId || null,
    pagamento: p.pagamento, obs: p.obs, textoWhatsapp: p.textoWhatsapp,
    quantidades: q, entregador: p.entregador || '', total: Number(p.total || 0)
  };
}

function paraLinha(p) {
  return {
    cliente: p.cliente,
    tipo: p.tipo,
    bairro_id: p.tipo === 'entrega' ? (p.bairroId || null) : null,
    pagamento: p.pagamento,
    obs: p.obs,
    texto_whatsapp: p.textoWhatsapp,
    itens: p.quantidades,
    entregador_nome: p.tipo === 'entrega' ? (p.entregador || '') : '',
    total: p.total
  };
}

function deLinha(r) {
  return {
    id: r.id,
    persistido: true,
    numero: r.numero,
    data: r.data,
    status: r.status,
    cliente: r.cliente || '',
    tipo: r.tipo,
    bairroId: r.bairro_id || null,
    pagamento: r.pagamento,
    obs: r.obs || '',
    textoWhatsapp: r.texto_whatsapp || '',
    quantidades: r.itens || {},
    entregador: r.entregador_nome || '',
    total: Number(r.total || 0)
  };
}

// Coloca um pedido na tela
function aplicarPedido(p) {
  aplicando = true;
  try {
    document.querySelectorAll('.item').forEach(item => {
      item.querySelector('.qtd-item').value = p.quantidades[item.dataset.nome] || 0;
    });

    campoCliente.value = p.cliente;
    campoObs.value = p.obs;
    textoWhatsapp.value = p.textoWhatsapp;

    document.querySelector(`input[name="tipo"][value="${p.tipo}"]`).checked = true;
    document.querySelector(`input[name="metodoPagamento"][value="${p.pagamento}"]`).checked = true;

    entregaInfo.classList.toggle('hidden', p.tipo !== 'entrega');
    entregadorInfo.classList.toggle('hidden', p.tipo !== 'entrega');
    renderEntregadores(p.tipo === 'entrega' ? (p.entregador || '') : '');
    bairroSelect.value = p.tipo === 'entrega' && p.bairroId ? String(p.bairroId) : '';

    calcularTotal();
    previewConteudo.textContent = montarTexto({ ...p, cliente: p.cliente.trim(), total: totalNumero() });
  } finally {
    aplicando = false;
  }
  renderAbas();
}


// =========================
// GRAVAÇÃO NO BANCO (com fila por pedido)
// =========================
function salvarPedidoAtual() {
  if (aplicando) return;
  const atual = pedidos.find(p => p.id === pedidoAtualId);
  if (!atual) return;

  const novo = capturarPedido();
  const mudou = JSON.stringify(camposGravaveis(novo)) !== JSON.stringify(camposGravaveis(atual));
  Object.assign(atual, novo);

  if (mudou) {
    atual._sujo = true;
    atual._versao = (atual._versao || 0) + 1;
    agendarGravacao(atual);
  }
  renderAbas();
}

function agendarGravacao(p) {
  clearTimeout(p._timer);
  clearTimeout(p._retry);
  indicador('salvando');
  p._timer = setTimeout(() => enfileirar(p), 600);
}

// Grava o pedido agora (junto com qualquer mudança de status pedida).
// Devolve true se deu certo.
function enfileirar(p, extra = {}) {
  clearTimeout(p._timer);
  p._cadeia = (p._cadeia || Promise.resolve()).then(() => gravarUmaVez(p, extra));
  return p._cadeia;
}

async function gravarUmaVez(p, extra) {
  const versao = p._versao || 0;
  indicador('salvando');
  try {
    if (!p.persistido) {
      const { data, error } = await sb.from('pedidos')
        .insert({ id: p.id, ...paraLinha(p), ...extra })
        .select('id, numero, data')
        .single();
      if (error) throw error;
      p.numero = data.numero;
      p.data = data.data;
      p.persistido = true;
    } else {
      const { error } = await sb.from('pedidos').update({ ...paraLinha(p), ...extra }).eq('id', p.id);
      if (error) throw error;
    }
    if ((p._versao || 0) === versao) p._sujo = false;
    if (!pedidos.some(x => x._sujo)) indicador('ok');
    renderAbas();
    return true;
  } catch (e) {
    console.error('Erro ao salvar pedido', e);
    indicador('erro');
    clearTimeout(p._retry);
    p._retry = setTimeout(() => enfileirar(p), 5000);
    return false;
  }
}


// =========================
// ABAS DE PEDIDOS
// =========================
function nomeDaAba(p) {
  return (p.cliente || '').trim() || (p.numero ? `Pedido ${p.numero}` : 'Novo pedido');
}

function renderAbas() {
  listaAbas.innerHTML = '';

  pedidos.forEach(p => {
    const aba = document.createElement('div');
    aba.className = 'aba-pedido' + (p.id === pedidoAtualId ? ' ativa' : '');

    const nome = document.createElement('button');
    nome.type = 'button';
    nome.className = 'aba-nome';
    nome.textContent = nomeDaAba(p);
    nome.addEventListener('click', () => trocarPedido(p.id));

    const fechar = document.createElement('button');
    fechar.type = 'button';
    fechar.className = 'aba-fechar';
    fechar.textContent = '×';
    fechar.title = 'Fechar ou cancelar este pedido';
    fechar.addEventListener('click', () => fecharPedido(p.id));

    aba.append(nome, fechar);
    listaAbas.appendChild(aba);
  });
}

function trocarPedido(id) {
  if (id === pedidoAtualId) return;
  salvarPedidoAtual();
  pedidoAtualId = id;
  aplicarPedido(pedidos.find(p => p.id === id));
}

function criarPedido() {
  salvarPedidoAtual();

  // Já existe um pedido em branco? Usa ele em vez de criar outro.
  const vazio = pedidos.find(p => !p.persistido && !p._sujo);
  const p = vazio || pedidoVazio();
  if (!vazio) pedidos.push(p);
  pedidoAtualId = p.id;

  aplicarPedido(p);
  campoCliente.focus();
}

// Tira a aba da lista (não mexe no banco)
function removerAba(id) {
  const posicao = pedidos.findIndex(x => x.id === id);
  if (posicao < 0) return;
  const eraAtual = id === pedidoAtualId;

  clearTimeout(pedidos[posicao]._timer);
  clearTimeout(pedidos[posicao]._retry);
  pedidos.splice(posicao, 1);

  if (pedidos.length === 0) {
    const novo = pedidoVazio();
    pedidos.push(novo);
    pedidoAtualId = novo.id;
    aplicarPedido(novo);
  } else if (eraAtual) {
    pedidoAtualId = pedidos[Math.max(0, posicao - 1)].id;
    aplicarPedido(pedidos.find(x => x.id === pedidoAtualId));
  } else {
    renderAbas();
  }
}

// ---- Fechar / Cancelar (nunca apaga) ----
const modalAba = document.getElementById('modal-aba');
let pedidoDoModalId = null;

function fecharPedido(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;

  if (id === pedidoAtualId) salvarPedidoAtual();

  // Aba em branco, que nunca foi salva: só remove da tela
  if (!p.persistido && !p._sujo) {
    removerAba(id);
    return;
  }

  pedidoDoModalId = id;
  document.getElementById('modal-aba-nome').textContent = nomeDaAba(p);
  modalAba.classList.remove('hidden');
}

function fecharModalAba() {
  modalAba.classList.add('hidden');
  pedidoDoModalId = null;
}

async function mudarStatus(status, motivo) {
  const p = pedidos.find(x => x.id === pedidoDoModalId);
  fecharModalAba();
  if (!p) return;

  const extra = { status };
  if (status === 'cancelado') extra.cancelado_motivo = motivo || '';

  const ok = await enfileirar(p, extra);
  if (!ok) {
    avisar('Não foi possível ' + (status === 'cancelado' ? 'cancelar' : 'fechar') + '. Verifique a internet.', true);
    return;
  }
  p.status = status;
  removerAba(p.id);
  avisar(status === 'cancelado' ? 'Pedido cancelado.' : 'Pedido fechado.');
}

document.getElementById('modal-aba-fechar').addEventListener('click', () => mudarStatus('fechado'));
document.getElementById('modal-aba-cancelar').addEventListener('click', () => {
  const motivo = prompt('Motivo do cancelamento (opcional):', '');
  if (motivo === null) return;
  mudarStatus('cancelado', motivo.trim());
});
document.getElementById('modal-aba-voltar').addEventListener('click', fecharModalAba);
modalAba.addEventListener('click', e => { if (e.target === modalAba) fecharModalAba(); });


// ---- Pedidos fechados / cancelados (para consultar e reabrir) ----
const modalFechados = document.getElementById('modal-fechados');
const inputDataFechados = document.getElementById('fechados-data');
const listaFechados = document.getElementById('lista-fechados');

async function carregarFechados() {
  listaFechados.textContent = 'Carregando…';
  const dia = inputDataFechados.value || diaOperacional();
  const { data, error } = await sb.from('pedidos')
    .select('*')
    .eq('data', dia)
    .in('status', ['fechado', 'cancelado'])
    .order('atualizado_em', { ascending: false });

  if (error) { listaFechados.textContent = 'Não foi possível carregar.'; return; }
  if (!data.length) { listaFechados.textContent = 'Nenhum pedido fechado ou cancelado neste dia.'; return; }

  listaFechados.innerHTML = '';
  data.forEach(r => {
    const p = deLinha(r);
    const linha = document.createElement('div');
    linha.className = 'linha-fechado';

    const info = document.createElement('div');
    info.className = 'linha-fechado-info';
    const nome = document.createElement('strong');
    nome.textContent = nomeDaAba(p);
    const detalhe = document.createElement('span');
    const etiqueta = r.status === 'cancelado' ? 'CANCELADO' : 'fechado';
    detalhe.textContent = ` · ${p.tipo} · R$ ${brl(p.total)} · ${etiqueta}` +
      (r.status === 'cancelado' && r.cancelado_motivo ? ` (${r.cancelado_motivo})` : '');
    info.append(nome, detalhe);

    const botao = document.createElement('button');
    botao.type = 'button';
    botao.textContent = 'Reabrir';
    botao.addEventListener('click', () => reabrirPedido(r.id));

    linha.append(info, botao);
    listaFechados.appendChild(linha);
  });
}

async function reabrirPedido(id) {
  const { data, error } = await sb.from('pedidos')
    .update({ status: 'aberto', cancelado_motivo: '' })
    .eq('id', id)
    .select('*')
    .single();
  if (error) { avisar('Não foi possível reabrir.', true); return; }

  let p = pedidos.find(x => x.id === id);
  if (!p) { p = deLinha(data); pedidos.push(p); }
  modalFechados.classList.add('hidden');
  salvarPedidoAtual();
  pedidoAtualId = p.id;
  aplicarPedido(p);
  avisar('Pedido reaberto.');
}

document.getElementById('btn-fechados').addEventListener('click', () => {
  inputDataFechados.value = diaOperacional();
  modalFechados.classList.remove('hidden');
  carregarFechados();
});
inputDataFechados.addEventListener('change', carregarFechados);
document.getElementById('btn-fechar-fechados').addEventListener('click', () => modalFechados.classList.add('hidden'));
modalFechados.addEventListener('click', e => { if (e.target === modalFechados) modalFechados.classList.add('hidden'); });


// =========================
// ENTREGADORES
// =========================
async function carregarEntregadores() {
  const { data, error } = await sb.from('entregadores')
    .select('nome').eq('ativo', true).order('id');
  if (!error && data && data.length) entregadores = data.map(x => x.nome);
  else if (!entregadores.length) entregadores = ['Entregador 1', 'Entregador 2'];
}

function renderEntregadores(selecionado) {
  listaEntregadores.innerHTML = '';

  const nomes = [...entregadores];
  if (selecionado && !nomes.includes(selecionado)) nomes.push(selecionado);

  nomes.forEach(nome => {
    const label = document.createElement('label');
    const radio = document.createElement('input');

    radio.type = 'radio';
    radio.name = 'entregador';
    radio.value = nome;
    radio.checked = nome === selecionado;
    radio.addEventListener('change', atualizarPreview);

    label.append(radio, ' ' + nome.toUpperCase());
    listaEntregadores.appendChild(label);
  });
}

async function editarEntregadores() {
  const atual = document.querySelector('input[name="entregador"]:checked')?.value || '';

  const resposta = prompt(
    'Entregadores de hoje, separados por vírgula (1 ou mais):',
    entregadores.join(', ')
  );
  if (resposta === null) return;

  const nomes = [...new Set(
    resposta.split(',').map(n => n.trim()).filter(Boolean)
  )];
  if (nomes.length === 0) return;

  const { data: existentes, error } = await sb.from('entregadores').select('id, nome, ativo');
  if (error) { avisar('Não foi possível salvar os entregadores.', true); return; }

  const porNome = new Map(existentes.map(x => [x.nome, x]));
  const novos = nomes.filter(n => !porNome.has(n)).map(n => ({ nome: n, ativo: true }));
  const reativar = nomes.filter(n => porNome.has(n) && !porNome.get(n).ativo).map(n => porNome.get(n).id);
  const desativar = existentes.filter(x => x.ativo && !nomes.includes(x.nome)).map(x => x.id);

  let falhou = false;
  if (novos.length) falhou = !!(await sb.from('entregadores').insert(novos)).error || falhou;
  if (reativar.length) falhou = !!(await sb.from('entregadores').update({ ativo: true }).in('id', reativar)).error || falhou;
  if (desativar.length) falhou = !!(await sb.from('entregadores').update({ ativo: false }).in('id', desativar)).error || falhou;
  if (falhou) { avisar('Alguns nomes não foram salvos.', true); }

  await carregarEntregadores();
  renderEntregadores(atual);
  atualizarPreview();
}

document.getElementById('editar-entregadores').addEventListener('click', editarEntregadores);


// =========================
// BAIRROS (vêm do banco; o balcão só vê a taxa do cliente)
// =========================
async function carregarBairros() {
  const { data, error } = await sb.from('bairros_balcao')
    .select('id, nome, taxa_cliente, ativo')
    .eq('ativo', true)
    .order('id');
  if (error) throw error;

  bairros = data.map(b => ({ id: b.id, nome: b.nome, taxa: Number(b.taxa_cliente) }));

  bairroSelect.innerHTML = '';
  const vazio = document.createElement('option');
  vazio.value = '';
  vazio.textContent = 'Bairro';
  bairroSelect.appendChild(vazio);

  bairros.forEach(b => {
    const op = document.createElement('option');
    op.value = String(b.id);
    op.dataset.taxa = String(b.taxa);
    op.textContent = `${b.nome} - R$${brl(b.taxa)}`;
    bairroSelect.appendChild(op);
  });
}


// =========================
// PEDIDOS ABERTOS: carregar e acompanhar em tempo real
// =========================
async function carregarPedidosAbertos() {
  const { data, error } = await sb.from('pedidos')
    .select('*')
    .eq('status', 'aberto')
    .order('criado_em', { ascending: true });
  if (error) throw error;

  pedidos = data.map(deLinha);
  if (pedidos.length === 0) pedidos.push(pedidoVazio());
  pedidoAtualId = pedidos[0].id;
  aplicarPedido(pedidos[0]);
}

// Atualiza a lista com o que veio do banco, sem mexer no que está sendo editado
function mesclarLinhaRemota(r) {
  const local = pedidos.find(p => p.id === r.id);

  if (r.status !== 'aberto') {
    if (local) removerAba(local.id);
    return;
  }

  const novo = deLinha(r);
  if (!local) {
    // a aba em branco fica sempre por último; a nova entra na frente dela
    const ultimo = pedidos[pedidos.length - 1];
    const posicao = ultimo && !ultimo.persistido && !ultimo._sujo ? pedidos.length - 1 : pedidos.length;
    pedidos.splice(posicao, 0, novo);
    renderAbas();
    return;
  }

  if (local._sujo) return; // o que está na tela é mais novo
  local.numero = novo.numero;
  local.data = novo.data;
  local.persistido = true;

  if (JSON.stringify(camposGravaveis(local)) === JSON.stringify(camposGravaveis(novo))) return;

  Object.assign(local, novo);
  if (local.id === pedidoAtualId) aplicarPedido(local);
  else renderAbas();
}

let jaConectouRealtime = false;
async function recarregarAbertos() {
  const { data, error } = await sb.from('pedidos').select('*').eq('status', 'aberto').order('criado_em', { ascending: true });
  if (error) return;
  const ids = new Set(data.map(r => r.id));
  data.forEach(mesclarLinhaRemota);
  pedidos.filter(p => p.persistido && !p._sujo && !ids.has(p.id)).forEach(p => removerAba(p.id));
}

function iniciarRealtime() {
  sb.channel('pedidos-ao-vivo')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pedidos' }, payload => {
      if (payload.eventType === 'DELETE') {
        const id = payload.old && payload.old.id;
        if (id && pedidos.some(p => p.id === id)) removerAba(id);
        return;
      }
      const r = payload.new;
      if (!r) return;
      verificarImpressaoRemota(r);
      mesclarLinhaRemota(r);
    })
    .subscribe(status => {
      if (status === 'SUBSCRIBED') {
        if (jaConectouRealtime) recarregarAbertos(); // voltou a internet: confere o que perdeu
        jaConectouRealtime = true;
      }
    });
}


// =========================
// ACERTO / ENTREGAS DA NOITE
// =========================
const modalFechamento = document.getElementById('modal-fechamento');
const btnAbrirFechamento = document.getElementById('btn-abrir-fechamento');
const btnFecharModal = document.getElementById('btn-fechar-modal');
const inputDataAcerto = document.getElementById('acerto-data');

async function gerarRelatorioFechamento() {
  const cont = document.getElementById('relatorio-motoboys');
  cont.textContent = 'Carregando…';

  // garante que o que está na tela já foi gravado
  salvarPedidoAtual();
  await Promise.all(pedidos.filter(p => p._sujo).map(p => enfileirar(p)));

  const dia = inputDataAcerto.value || diaOperacional();
  const ehAdmin = usuario.papel === 'admin';

  const consultaEntregas = ehAdmin
    ? sb.from('entregas').select('entregador_nome, bairro_nome, taxa_motoboy').eq('data', dia)
    : sb.from('entregas_balcao').select('entregador_nome, bairro_nome').eq('data', dia);

  const [ent, sem] = await Promise.all([
    consultaEntregas,
    sb.from('pedidos').select('id').eq('data', dia).eq('tipo', 'entrega').eq('entregador_nome', '').neq('status', 'cancelado')
  ]);

  if (ent.error) { cont.textContent = 'Não foi possível carregar as entregas.'; return; }

  const resumo = {};
  let totalEntregas = 0;
  let totalBoys = 0;

  ent.data.forEach(e => {
    const nome = e.entregador_nome;
    if (!resumo[nome]) resumo[nome] = { qtd: 0, total: 0 };
    resumo[nome].qtd += 1;
    totalEntregas += 1;
    if (ehAdmin) {
      const taxa = Number(e.taxa_motoboy || 0);
      resumo[nome].total += taxa;
      totalBoys += taxa;
    }
  });

  cont.innerHTML = '';
  const nomes = Object.keys(resumo);

  if (nomes.length === 0) {
    const vazio = document.createElement('p');
    vazio.textContent = 'Nenhuma entrega com entregador atribuído neste dia.';
    cont.appendChild(vazio);
  }

  nomes.forEach(nome => {
    const dados = resumo[nome];
    const card = document.createElement('div');
    card.className = 'card-motoboy';

    const titulo = document.createElement('h4');
    titulo.textContent = '🛵 ' + nome;

    const pQtd = document.createElement('p');
    pQtd.innerHTML = '<strong>Total de Entregas:</strong> ' + dados.qtd;
    card.append(titulo, pQtd);

    if (ehAdmin) {
      const pValor = document.createElement('p');
      pValor.innerHTML = '<strong>Valor a Receber:</strong> R$ ' + brl(dados.total);
      card.appendChild(pValor);
    }
    cont.appendChild(card);
  });

  if (!sem.error && sem.data.length > 0) {
    const aviso = document.createElement('p');
    aviso.style.color = '#b00';
    aviso.textContent = '⚠ ' + sem.data.length + ' entrega(s) sem entregador marcado.';
    cont.appendChild(aviso);
  }

  if (nomes.length > 0) {
    const rodape = document.createElement('div');
    rodape.style.marginTop = '15px';
    rodape.style.paddingTop = '10px';
    rodape.style.borderTop = '2px solid #222';
    rodape.innerHTML = '<p><strong>Total Geral de Entregas:</strong> ' + totalEntregas + '</p>' +
      (ehAdmin ? '<p><strong>Total Gasto com Motoboys:</strong> R$ ' + brl(totalBoys) + '</p>' : '');
    cont.appendChild(rodape);
  }
}

btnAbrirFechamento.addEventListener('click', () => {
  inputDataAcerto.value = diaOperacional();
  document.getElementById('titulo-acerto').textContent =
    usuario && usuario.papel === 'admin' ? 'Acerto Motoboy' : 'Entregas da Noite';
  modalFechamento.classList.remove('hidden');
  gerarRelatorioFechamento();
});
inputDataAcerto.addEventListener('change', gerarRelatorioFechamento);
btnFecharModal.addEventListener('click', () => modalFechamento.classList.add('hidden'));
modalFechamento.addEventListener('click', e => { if (e.target === modalFechamento) modalFechamento.classList.add('hidden'); });


// =========================
// LOGIN
// =========================
const formLogin = document.getElementById('form-login');
const loginErro = document.getElementById('login-erro');
const loginBotao = document.getElementById('login-entrar');

formLogin.addEventListener('submit', async e => {
  e.preventDefault();
  loginErro.textContent = '';
  loginBotao.disabled = true;
  loginBotao.textContent = 'Entrando…';

  const { data, error } = await sb.auth.signInWithPassword({
    email: document.getElementById('login-email').value.trim(),
    password: document.getElementById('login-senha').value
  });

  if (error || !data || !data.user) {
    loginErro.textContent = 'E-mail ou senha incorretos.';
    loginBotao.disabled = false;
    loginBotao.textContent = 'Entrar';
    return;
  }

  await iniciarApp(data.user);
  loginBotao.disabled = false;
  loginBotao.textContent = 'Entrar';
});

document.getElementById('btn-sair').addEventListener('click', async () => {
  await sb.auth.signOut();
  location.reload();
});

let appIniciado = false;
async function iniciarApp(user) {
  if (appIniciado) return;
  loginErro.textContent = '';

  try {
    const { data: perfil, error } = await sb.from('perfis')
      .select('nome, papel, ativo').eq('id', user.id).maybeSingle();
    if (error) throw error;

    if (!perfil || !perfil.ativo) {
      loginErro.textContent = 'Este usuário não tem permissão para usar o sistema.';
      await sb.auth.signOut();
      return;
    }

    usuario = { id: user.id, nome: perfil.nome, papel: perfil.papel };
    await Promise.all([carregarBairros(), carregarEntregadores()]);
    await carregarPedidosAbertos();

    document.getElementById('conta-usuario').textContent =
      (perfil.nome || user.email) + (perfil.papel === 'admin' ? ' (admin)' : '');
    document.body.classList.add('logado', 'papel-' + perfil.papel);
    appIniciado = true;
    indicador('ok');
    iniciarRealtime();
  } catch (e) {
    console.error(e);
    loginErro.textContent = 'Não foi possível carregar os dados. Verifique a internet e tente de novo.';
  }
}

// Aviso se tentar fechar a página com pedido ainda sem gravar
window.addEventListener('beforeunload', e => {
  if (pedidos.some(p => p._sujo)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

(async function iniciar() {
  const { data } = await sb.auth.getSession();
  if (data && data.session && data.session.user) await iniciarApp(data.session.user);
})();
