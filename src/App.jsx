import { useState, useCallback, useMemo, useEffect } from "react";
import Papa from "papaparse";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Cell } from "recharts";

const C = {
  laranja: "#F97316", laranjaLight: "#FED7AA",
  verde: "#16A34A", verdeLight: "#BBF7D0",
  vermelho: "#DC2626", vermelhoLight: "#FEE2E2",
  amarelo: "#CA8A04", amareloLight: "#FEF08A",
  azul: "#2563EB", azulLight: "#DBEAFE",
  cinzaFundo: "#F8F7F4", cinzaCard: "#FFFFFF",
  cinzaBorda: "#E5E3DF", cinzaTexto: "#6B7280", texto: "#1C1917",
};

const pct = (v) => typeof v === "number" ? (v * 100).toFixed(2) + "%" : "—";

const TRANSP_MAP = {
  "SAFARI MONTAGEM": "Safari", "MOVEL SERVICE": "Movel Service",
  "SALDAO CAMPINAS": "Saldão", "LIFE - GERENCIA": "LOGME",
  "LOGME - TRANSPO": "LOGME", "OUTELETRO BH": "Outeletro BH",
  "AGMX OPORTUNIDA": "Ponto Mix", "ORC MOVEIS E EL": "ORC",
  "KMAN MOVEIS": "KMAN", "REAL MOWEIS COM": "Real Moweis",
  "TARCIS MARQUES": "Tarcis", "E S L KOSLYK CO": "Ebenezer",
  "ELETROSHOW OUTL": "Eletroshow", "MEGA MULTI OUTL": "Mega Multi",
  "TOPA TUDO MOVEI": "Topa Tudo", "TRINDADE & CUBA": "Trindade",
  "OUTLET D TUDO": "Outlet D Tudo", "JEV TRANSP": "JEV",
  "MOVEIS CAMILO L": "Camilo",
};
const normTransp = (t) => TRANSP_MAP[t?.trim()] || t?.trim() || "Outros";

function parseDate(str) {
  if (!str) return null;
  const parts = str.trim().split("/");
  if (parts.length !== 3) return null;
  return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
}
function getISOWeek(d) {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
}

// ── localStorage — semanas travadas ──────────────────────────────────────────
const STORAGE_KEY = "csat_semanas_travadas";

function carregarSemanasTravadas() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {}; // { "2026_W10": {...agregado} }
  } catch { return {}; }
}

function salvarSemanasTravadas(travadas) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(travadas)); } catch {}
}

function chaveWeek(ano, semana) { return `${ano}_W${semana}`; }

// ── Parser principal ──────────────────────────────────────────────────────────
function parseData(respostas, disparos, semanasTravadas = {}) {
  // Enriquecer respostas (sem filtro ainda)
  const respAll = respostas.map(r => ({
    ...r,
    semana: parseInt(r["Semana Resposta"]),
    mes: parseInt(r["Mês Resposta"]),
    ano: parseInt(r["Ano Resposta"]),
    nota: parseInt(r["experiencia_geral"]),
    transp: normTransp(r["TRANSPORTADORA"]),
    comentario: r["comentario_aberto"]?.trim() || "",
  })).filter(r => !isNaN(r.semana) && !isNaN(r.nota) && !isNaN(r.ano));

  // Detectar o ano da semana mais recente (evita misturar anos)
  const maisRecente = respAll.slice().sort((a, b) => b.ano !== a.ano ? b.ano - a.ano : b.semana - a.semana)[0];
  const anoAtual = maisRecente ? maisRecente.ano : new Date().getFullYear();

  // Filtrar respostas pelo ano da semana mais recente
  const respEnrich = respAll.filter(r => r.ano === anoAtual);

  // Enriquecer disparos — sem filtro de ano (disparo pode ser de ano anterior à resposta)
  const dispEnrich = disparos.map(r => {
    const d = parseDate(r["Disparo"]);
    if (!d) return null;
    return {
      semana: getISOWeek(d),
      mes: d.getMonth() + 1,
      ano: d.getFullYear(),
      transp: normTransp(r["Transportadora"]),
    };
  }).filter(r => r !== null);

  // Chave de travamento inclui ano para evitar colisão entre anos
  const chaveW = (semana) => `${anoAtual}_W${semana}`;

  // Semanas e meses disponíveis com >= 20 respostas
  const semanaSet = [...new Set(respEnrich.map(r => r.semana))].sort((a,b) => a-b);
  const mesSet = [...new Set(respEnrich.map(r => r.mes))].sort((a,b) => a-b);

  // Semanas com >= 20 respostas no CSV atual
  const semanasNovas = semanaSet.filter(w => respEnrich.filter(r => r.semana === w).length >= 20);

  // Última semana em andamento (< 10 respostas)
  const ultimaSemanaRaw = semanaSet[semanaSet.length - 1];
  const ultimaSemanaResp = ultimaSemanaRaw ? respEnrich.filter(r => r.semana === ultimaSemanaRaw).length : 0;
  const ultimaSemanaEmAndamento = ultimaSemanaRaw && !semanasNovas.includes(ultimaSemanaRaw) && ultimaSemanaResp > 0;
  if (ultimaSemanaEmAndamento && ultimaSemanaResp >= 10) {
    semanasNovas.push(ultimaSemanaRaw);
  }

  // Calcular agregados do CSV para semanas novas — salvar as que atingiram >= 20
  const novasTravadas = { ...semanasTravadas };
  semanasNovas.forEach(w => {
    const chave = chaveW(w);
    const respW = respEnrich.filter(r => r.semana === w);
    const dispW = dispEnrich.filter(r => r.semana === w);
    const totalResp = respW.length;
    if (totalResp >= 20 && !novasTravadas[chave]) {
      novasTravadas[chave] = calcAgregado(respW, dispW, `W${w}`, w, null);
    }
  });
  salvarSemanasTravadas(novasTravadas);

  // Unir semanas travadas + semanas novas ainda não travadas
  const todasSemanas = [...new Set([
    ...Object.keys(novasTravadas)
      .filter(k => k.startsWith(`${anoAtual}_W`))
      .map(k => parseInt(k.split("_W")[1])),
    ...semanasNovas,
  ])].sort((a, b) => a - b);

  const semanas = todasSemanas;

  // Calcular porSemana: usar travado se disponível, senão calcular do CSV
  const porSemana = semanas.map(w => {
    const chave = chaveW(w);
    if (novasTravadas[chave]) return novasTravadas[chave];
    return calcAgregado(
      respEnrich.filter(r => r.semana === w),
      dispEnrich.filter(r => r.semana === w),
      `W${w}`, w, null
    );
  });

  const meses = mesSet.filter(m => respEnrich.filter(r => r.mes === m).length >= 20);

  const porMes = meses.map(m => calcAgregado(
    respEnrich.filter(r => r.mes === m),
    dispEnrich.filter(r => r.mes === m),
    `M${m}`, null, m
  ));

  const semanasTravadasCount = Object.keys(novasTravadas).filter(k => k.startsWith(`${anoAtual}_W`)).length;

  return { respEnrich, dispEnrich, porSemana, porMes, semanas, meses, ultimaSemanaEmAndamento, ultimaSemanaRaw, ultimaSemanaResp, semanasTravadasCount, anoAtual };
}

function calcAgregado(resp, disp, label, semana, mes) {
  const notas45 = resp.filter(r => r.nota >= 4).length;
  const share = resp.length ? notas45 / resp.length : null;
  const taxa = disp.length ? resp.length / disp.length : null;

  // Por parceiro
  const transpSet = [...new Set(resp.map(r => r.transp))];
  const parceiros = transpSet.map(t => {
    const rT = resp.filter(r => r.transp === t);
    const dT = disp.filter(r => r.transp === t);
    const n45 = rT.filter(r => r.nota >= 4).length;
    return {
      nome: t,
      respostas: rT.length,
      disparos: dT.length,
      share: rT.length ? n45 / rT.length : null,
      taxa: dT.length ? rT.length / dT.length : null,
      notas: [1,2,3,4,5].map(n => ({ nota: n, qtd: rT.filter(r => r.nota === n).length })),
    };
  }).sort((a,b) => (a.share ?? 1) - (b.share ?? 1));

  // Motivos 1-3
  const resp13 = resp.filter(r => r.nota <= 3);
  const dims = [
    { key: "experiencia_geral", label: "Experiência Geral" },
    { key: "agendamento_servico", label: "Agendamento" },
    { key: "cumprimento_data_agendamento", label: "Cumprimento Agendamento" },
    { key: "postura_profissional", label: "Postura Profissional" },
  ];
  const motivos = dims.map(d => ({
    label: d.label,
    count: resp13.filter(r => parseInt(r[d.key]) <= 3).length,
  })).sort((a,b) => b.count - a.count);

  // Comentários
  const comentariosNeg = resp.filter(r => r.nota <= 3 && r.comentario)
    .map(r => ({ nota: r.nota, transp: r.transp, comentario: r.comentario, semana: r.semana }));
  const comentariosPos = resp.filter(r => r.nota >= 4 && r.comentario)
    .map(r => ({ nota: r.nota, transp: r.transp, comentario: r.comentario, semana: r.semana }));

  return {
    label, semana, mes,
    respostas: resp.length, disparos: disp.length,
    share, taxa, notas45,
    parceiros, motivos,
    comentariosNeg, comentariosPos,
    // Versão slim para compartilhamento (sem comentários)
    slim: { label, semana, mes, respostas: resp.length, disparos: disp.length, share, taxa, notas45, parceiros, motivos },
  };
}

// ── Componentes base ──────────────────────────────────────────────────────────
function Card({ children, style }) {
  return <div style={{ background: C.cinzaCard, border: `1px solid ${C.cinzaBorda}`, borderRadius: 12, padding: "20px 24px", ...style }}>{children}</div>;
}
function SecHead({ children }) {
  return <p style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: C.cinzaTexto, marginBottom: 12 }}>{children}</p>;
}
function KpiCard({ label, value, format, meta, badge }) {
  const atMeta = meta !== undefined && value !== null ? value >= meta : null;
  return (
    <div style={{ background: C.cinzaCard, border: `1px solid ${C.cinzaBorda}`, borderRadius: 12, padding: "16px 20px", display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: C.cinzaTexto }}>{label}</span>
        {badge && <span style={{ fontSize: 10, color: C.laranja, fontWeight: 700, background: C.laranjaLight, borderRadius: 20, padding: "1px 8px" }}>{badge}</span>}
      </div>
      <span style={{ fontSize: 28, fontWeight: 700, color: atMeta === false ? C.vermelho : atMeta === true ? C.verde : C.texto }}>
        {value === null ? "—" : format(value)}
      </span>
      {meta !== undefined && (
        <span style={{ fontSize: 11, color: C.cinzaTexto }}>
          Meta: {format(meta)}
          {atMeta !== null && <span style={{ marginLeft: 6, color: atMeta ? C.verde : C.vermelho, fontWeight: 600 }}>{atMeta ? "✓" : "✗"}</span>}
        </span>
      )}
    </div>
  );
}

function ComentariosList({ items, cor, max = 200 }) {
  const [expanded, setExpanded] = useState(false);
  const show = expanded ? items : items.slice(0, 5);
  return (
    <div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: expanded ? "none" : max, overflowY: expanded ? "visible" : "auto" }}>
        {show.map((c, i) => (
          <div key={i} style={{ display: "flex", gap: 10, padding: "9px 12px", background: C.cinzaFundo, borderRadius: 8, borderLeft: `3px solid ${c.nota <= 1 ? C.vermelho : c.nota <= 3 ? C.amarelo : C.verde}` }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: c.nota <= 1 ? C.vermelho : c.nota <= 3 ? C.amarelo : C.verde, flexShrink: 0 }}>★{c.nota}</span>
            <span style={{ fontSize: 11, color: C.laranja, fontWeight: 600, flexShrink: 0, width: 80 }}>{c.transp}</span>
            {c.semana && <span style={{ fontSize: 11, color: C.cinzaTexto, flexShrink: 0 }}>W{c.semana}</span>}
            <span style={{ fontSize: 12, color: C.texto, lineHeight: 1.4 }}>{c.comentario}</span>
          </div>
        ))}
      </div>
      {items.length > 5 && (
        <button onClick={() => setExpanded(!expanded)} style={{ marginTop: 8, fontSize: 12, color: C.laranja, fontWeight: 600, background: "none", border: "none", cursor: "pointer" }}>
          {expanded ? "▲ Mostrar menos" : `▼ Ver todos (${items.length})`}
        </button>
      )}
    </div>
  );
}

// ── Upload Zone ───────────────────────────────────────────────────────────────
function UploadZone({ label, icon, loaded, onFile }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "24px", border: `2px dashed ${loaded ? C.verde : C.cinzaBorda}`, borderRadius: 12, cursor: "pointer", background: loaded ? C.verdeLight + "44" : C.cinzaCard }}>
      <span style={{ fontSize: 28 }}>{loaded ? "✅" : icon}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: loaded ? C.verde : C.texto }}>{loaded ? "Carregado ✓" : label}</span>
      <span style={{ fontSize: 11, color: C.cinzaTexto }}>{loaded ? "Clique para trocar" : "Clique ou arraste o CSV"}</span>
      <input type="file" accept=".csv" onChange={onFile} style={{ display: "none" }} />
    </label>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
// ── Encode/decode com compressão ────────────────────────────────────────────
async function encodeData(data) {
  const json = JSON.stringify(data);
  const bytes = new TextEncoder().encode(json);
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const compressed = await new Response(cs.readable).arrayBuffer();
  const b64 = btoa(String.fromCharCode(...new Uint8Array(compressed)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function decodeData(encoded) {
  try {
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length).map((_, i) => binary.charCodeAt(i));
    const ds = new DecompressionStream("deflate");
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const decompressed = await new Response(ds.readable).arrayBuffer();
    return JSON.parse(new TextDecoder().decode(decompressed));
  } catch { return null; }
}

export default function App() {
  const [respostas, setRespostas] = useState(null);
  const [disparos, setDisparos] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [tab, setTab] = useState("overview");
  const [modoPeriodo, setModoPeriodo] = useState("semana");
  const [periodoSel, setPeriodoSel] = useState(null);
  const [copied, setCopied] = useState(false);
  const [linkGerado, setLinkGerado] = useState(null);
  const [fromURL, setFromURL] = useState(false);
  const [parceroFiltro, setParceroFiltro] = useState("Todos");
  const [modoSelecao, setModoSelecao] = useState("unico"); // "unico" | "consolidar" | "comparar"
  const [periodosMulti, setPeriodosMulti] = useState([]); // períodos selecionados no modo multi

  // Carregar dados da URL ao montar
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const d = params.get("d");
    if (d) {
      decodeData(d).then(decoded => {
        if (decoded) {
          // Restaurar estrutura completa com comentários vazios
          const restored = {
            ...decoded,
            porSemana: (decoded.porSemana || []).map(p => ({
              ...p,
              comentariosNeg: [],
              comentariosPos: [],
              slim: p,
            })),
            porMes: (decoded.porMes || []).map(p => ({
              ...p,
              comentariosNeg: [],
              comentariosPos: [],
              slim: p,
            })),
            semanasTravadasCount: (decoded.porSemana || []).length,
          };
          setParsed(restored);
          setPeriodoSel(decoded.semanas?.[decoded.semanas.length - 1] || null);
          setFromURL(true);

          // Salvar semanas do link no localStorage como base para próximo upload
          const travadas = {};
          const anoLink = decoded.anoAtual || new Date().getFullYear();
          for (const p of (decoded.porSemana || [])) {
            if (p.semana && p.respostas >= 20) {
              travadas[`${anoLink}_W${p.semana}`] = p;
            }
          }
          if (Object.keys(travadas).length > 0) {
            // Mesclar com o que já estava no localStorage (sem sobrescrever)
            const existentes = carregarSemanasTravadas();
            const merged = { ...travadas, ...existentes };
            salvarSemanasTravadas(merged);
          }
        }
      });
    }
  }, []);

  const loadCSV = useCallback((setter, onDone) => (e) => {
    const file = e.target.files[0];
    if (!file) return;
    Papa.parse(file, { header: true, skipEmptyLines: true, complete: ({ data }) => { setter(data); if (onDone) onDone(data); } });
  }, []);

  const calcular = useCallback((resp, disp) => {
    if (resp && disp) {
      const semanasTravadas = carregarSemanasTravadas();
      const result = parseData(resp, disp, semanasTravadas);
      setParsed(result);
      setPeriodoSel(result.semanas[result.semanas.length - 1] || null);
      setFromURL(false);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const onRespostas = loadCSV(setRespostas, (d) => calcular(d, disparos));
  const onDisparos = loadCSV(setDisparos, (d) => calcular(respostas, d));

  // Exportar link comprimido — inclui todas as semanas travadas
  const exportLink = useCallback(async () => {
    if (!parsed) return;
    setCopied("loading");
    let url = null;
    try {
      const slim = {
        semanas: parsed.semanas,
        meses: parsed.meses,
        anoAtual: parsed.anoAtual || new Date().getFullYear(),
        porSemana: parsed.porSemana.map(p => p.slim || p),
        porMes: parsed.porMes.map(p => p.slim || p),
      };
      const encoded = await encodeData(slim);
      url = `${window.location.origin}${window.location.pathname}?d=${encoded}`;
      setLinkGerado(url);
    } catch (e) {
      console.error("Erro ao gerar link:", e);
      setCopied(false);
      return;
    }
    // Tentar copiar para clipboard
    let copiou = false;
    try {
      await navigator.clipboard.writeText(url);
      copiou = true;
    } catch {
      // Fallback: criar elemento temporário
      try {
        const el = document.createElement("textarea");
        el.value = url;
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.focus();
        el.select();
        copiou = document.execCommand("copy");
        document.body.removeChild(el);
      } catch { copiou = false; }
    }
    if (copiou) {
      setCopied("done");
      setTimeout(() => setCopied(false), 4000);
    } else {
      setCopied("manual");
    }
  }, [parsed]);

  // Auto-switch para aba comparar quando modo muda para comparar
  useEffect(() => {
    if (modoSelecao === "comparar") {
      setTab("comparar");
    } else if (tab === "comparar") {
      setTab("overview");
    }
  }, [modoSelecao]);

  // Lista de períodos para o seletor
  const periodos = useMemo(() => {
    if (!parsed) return [];
    if (modoPeriodo === "semana") return parsed.semanas.map(w => ({ val: w, label: `W${w}` }));
    return parsed.meses.map(m => ({ val: m, label: `Mês ${m}` }));
  }, [parsed, modoPeriodo]);

  // Histórico para gráficos
  const historico = useMemo(() => {
    if (!parsed) return [];
    return (modoPeriodo === "semana" ? parsed.porSemana : parsed.porMes).map(p => ({ label: p.label, share: p.share, taxa: p.taxa }));
  }, [parsed, modoPeriodo]);

  // Resetar filtro ao trocar período
  const setPeriodoSelComReset = useCallback((val) => {
    setPeriodoSel(val);
    setParceroFiltro("Todos");
  }, []);

  // Toggle período no modo multi
  const togglePeriodoMulti = useCallback((val) => {
    setPeriodosMulti(prev => {
      if (prev.includes(val)) return prev.filter(p => p !== val);
      return [...prev, val].sort((a,b) => a-b);
    });
    setParceroFiltro("Todos");
  }, []);

  // Consolidar múltiplos períodos em um único agregado
  const consolidarPeriodos = useCallback((lista, source) => {
    if (!lista.length) return null;
    const totalResp = lista.reduce((s, p) => s + p.respostas, 0);
    const totalDisp = lista.reduce((s, p) => s + p.disparos, 0);
    const totalN45 = lista.reduce((s, p) => s + p.notas45, 0);
    const share = totalResp ? totalN45 / totalResp : null;
    const taxa = totalDisp ? totalResp / totalDisp : null;

    // Parceiros consolidados
    const parcMap = {};
    lista.forEach(p => {
      p.parceiros.forEach(pa => {
        if (!parcMap[pa.nome]) parcMap[pa.nome] = { nome: pa.nome, respostas: 0, disparos: 0, n45: 0, notas: [1,2,3,4,5].map(n => ({ nota: n, qtd: 0 })) };
        parcMap[pa.nome].respostas += pa.respostas;
        parcMap[pa.nome].disparos += pa.disparos;
        parcMap[pa.nome].n45 += pa.notas.filter(n => n.nota >= 4).reduce((s,n) => s+n.qtd, 0);
        pa.notas.forEach(n => { parcMap[pa.nome].notas.find(x => x.nota === n.nota).qtd += n.qtd; });
      });
    });
    const parceiros = Object.values(parcMap).map(p => ({
      ...p, share: p.respostas ? p.n45 / p.respostas : null,
      taxa: p.disparos ? p.respostas / p.disparos : null,
    })).sort((a,b) => (a.share??1)-(b.share??1));

    // Motivos consolidados
    const motivosMap = {};
    lista.forEach(p => {
      p.motivos.forEach(m => {
        if (!motivosMap[m.label]) motivosMap[m.label] = { label: m.label, count: 0 };
        motivosMap[m.label].count += m.count;
      });
    });
    const motivos = Object.values(motivosMap).sort((a,b) => b.count-a.count);

    // Comentários
    const comentariosNeg = lista.flatMap(p => p.comentariosNeg || []);
    const comentariosPos = lista.flatMap(p => p.comentariosPos || []);

    const labels = lista.map(p => p.label).join(", ");
    return {
      label: labels, semana: null, mes: null,
      respostas: totalResp, disparos: totalDisp, notas45: totalN45,
      share, taxa, parceiros, motivos, comentariosNeg, comentariosPos,
      slim: { label: labels, semana: null, mes: null, respostas: totalResp, disparos: totalDisp, notas45: totalN45, share, taxa, parceiros, motivos },
    };
  }, []);

  // Período(s) ativos para exibição
  const periodosAtivos = useMemo(() => {
    if (!parsed) return [];
    const source = modoPeriodo === "semana" ? parsed.porSemana : parsed.porMes;
    if (modoSelecao === "unico") {
      const p = source.find(s => (modoPeriodo === "semana" ? s.semana : s.mes) === periodoSel) || source[source.length-1];
      return p ? [p] : [];
    }
    return source.filter(p => periodosMulti.includes(modoPeriodo === "semana" ? p.semana : p.mes));
  }, [parsed, modoPeriodo, modoSelecao, periodoSel, periodosMulti]);

  const periodoConsolidado = useMemo(() => {
    if (modoSelecao !== "consolidar" || !periodosAtivos.length) return null;
    return consolidarPeriodos(periodosAtivos);
  }, [modoSelecao, periodosAtivos, consolidarPeriodos]);

  // Período atual selecionado — definido APÓS periodoConsolidado
  const periodoAtual = useMemo(() => {
    if (!parsed) return null;
    if (modoSelecao === "consolidar" && periodoConsolidado) return periodoConsolidado;
    if (modoPeriodo === "semana") return parsed.porSemana.find(s => s.semana === periodoSel) || parsed.porSemana[parsed.porSemana.length - 1];
    return parsed.porMes.find(m => m.mes === periodoSel) || parsed.porMes[parsed.porMes.length - 1];
  }, [parsed, modoPeriodo, periodoSel, modoSelecao, periodoConsolidado]);

  // Dados filtrados pelo parceiro selecionado
  const periodoFiltrado = useMemo(() => {
    if (!periodoAtual || parceroFiltro === "Todos") return periodoAtual;
    return {
      ...periodoAtual,
      parceiros: periodoAtual.parceiros.filter(p => p.nome === parceroFiltro),
      motivos: (() => {
        // Recalcular motivos só para o parceiro filtrado
        const comsNeg = periodoAtual.comentariosNeg.filter(c => c.transp === parceroFiltro);
        const dims = [
          { key: "experiencia_geral", label: "Experiência Geral" },
          { key: "agendamento_servico", label: "Agendamento" },
          { key: "cumprimento_data_agendamento", label: "Cumprimento Agendamento" },
          { key: "postura_profissional", label: "Postura Profissional" },
        ];
        // Como não temos as notas por dimensão nos comentários, usamos os motivos gerais proporcionalmente
        const totalNeg = periodoAtual.comentariosNeg.length;
        const parcNeg = comsNeg.length;
        const fator = totalNeg > 0 ? parcNeg / totalNeg : 0;
        return periodoAtual.motivos.map(m => ({
          ...m,
          count: Math.round(m.count * fator),
        }));
      })(),
      comentariosNeg: periodoAtual.comentariosNeg.filter(c => c.transp === parceroFiltro),
      comentariosPos: periodoAtual.comentariosPos.filter(c => c.transp === parceroFiltro),
    };
  }, [periodoAtual, parceroFiltro]);

  // Lista de parceiros — depende de periodoAtual (definido acima)
  const parceirosDisponiveis = useMemo(() => {
    if (!periodoAtual) return [];
    const nomes = periodoAtual.parceiros.map(p => p.nome).sort();
    return ["Todos", ...nomes];
  }, [periodoAtual]);

  const tabs = useMemo(() => {
    const base = [
      { id: "overview", label: "Visão Geral" },
      { id: "parceiros", label: "Por Parceiro" },
      { id: "motivos", label: "Motivos 1-3" },
      { id: "comentarios", label: "Comentários" },
    ];
    if (modoSelecao === "comparar") base.push({ id: "comparar", label: "⚡ Comparação" });
    return base;
  }, [modoSelecao]);

  return (
    <div style={{ minHeight: "100vh", background: C.cinzaFundo, fontFamily: "'Inter','Segoe UI',sans-serif", color: C.texto }}>
      {/* Header */}
      <div style={{ background: C.laranja, padding: "0 32px" }}>
        <div style={{ maxWidth: 1000, margin: "0 auto", display: "flex", alignItems: "center", height: 56, gap: 12 }}>
          <span style={{ fontSize: 22 }}>⭐</span>
          <span style={{ color: "#fff", fontWeight: 700, fontSize: 16 }}>CSAT Parça</span>
          {periodoAtual && <span style={{ color: "#fff9", fontSize: 13 }}>— {periodoAtual.label} / 2026</span>}
          <div style={{ marginLeft: "auto" }}>
            {parsed && (
              <button onClick={exportLink} style={{
                background: copied === "done" ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.15)",
                border: "1px solid rgba(255,255,255,0.3)", borderRadius: 8,
                padding: "6px 14px", cursor: copied === "loading" ? "not-allowed" : "pointer",
                color: "#fff", fontSize: 13, fontWeight: 600,
              }}>
                {copied === "loading" ? "⏳ Gerando..." : copied === "done" ? "✓ Link copiado!" : copied === "manual" ? "📋 Copie o link abaixo" : "🔗 Compartilhar link"}
              </button>
            )}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "28px 32px" }}>
        {/* Upload compacto */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, padding: "8px 16px", background: C.cinzaCard, border: `1px solid ${C.cinzaBorda}`, borderRadius: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: C.cinzaTexto, flexShrink: 0 }}>Bases:</span>
          {[
            { label: "Respostas", loaded: !!respostas, onFile: onRespostas },
            { label: "Disparos", loaded: !!disparos, onFile: onDisparos },
          ].map((item, i) => (
            <label key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 12px", borderRadius: 20, cursor: "pointer", border: `1px solid ${item.loaded ? C.verde : C.cinzaBorda}`, background: item.loaded ? C.verdeLight + "55" : C.cinzaFundo }}>
              <span style={{ fontSize: 13 }}>{item.loaded ? "✅" : "📂"}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: item.loaded ? C.verde : C.cinzaTexto }}>{item.label}{item.loaded ? " ✓" : ""}</span>
              <input type="file" accept=".csv" onChange={item.onFile} style={{ display: "none" }} />
            </label>
          ))}
          {(!respostas || !disparos) && (
            <span style={{ fontSize: 11, color: C.cinzaTexto, marginLeft: 4 }}>Suba os dois CSVs para carregar o dashboard</span>
          )}
          {respostas && disparos && (
            <span style={{ fontSize: 11, color: C.verde, marginLeft: 4, fontWeight: 600 }}>✓ Prontos — clique em qualquer base para trocar</span>
          )}
          {parsed && parsed.semanasTravadasCount > 0 && (
            <span style={{ fontSize: 11, color: C.azul, marginLeft: "auto", background: C.azulLight, borderRadius: 20, padding: "3px 10px", fontWeight: 600 }}>
              🔒 {parsed.semanasTravadasCount} semana{parsed.semanasTravadasCount !== 1 ? "s" : ""} travada{parsed.semanasTravadasCount !== 1 ? "s" : ""}
              <button onClick={() => { if (window.confirm("Apagar todas as semanas travadas? Os dados serão recalculados do CSV.")) { localStorage.removeItem(STORAGE_KEY); calcular(respostas, disparos); } }} style={{ marginLeft: 8, fontSize: 10, color: C.vermelho, background: "none", border: "none", cursor: "pointer", fontWeight: 700, padding: 0 }}>✕ limpar</button>
            </span>
          )}
        </div>

        {!parsed && (
          <div style={{ textAlign: "center", padding: "48px 0", color: C.cinzaTexto }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>👆</div>
            <p style={{ fontSize: 15 }}>Suba os dois CSVs para calcular os indicadores automaticamente</p>
          </div>
        )}

        {parsed && periodoAtual && (
          <>
            {/* Banner fromURL */}
            {fromURL && (
              <div style={{ marginBottom: 16, padding: "10px 16px", background: "#DBEAFE", border: "1px solid #93C5FD", borderRadius: 8, fontSize: 13, color: "#1D4ED8", fontWeight: 500 }}>
                📎 Dashboard carregado do link compartilhado — {periodoAtual?.label}/2026.
                <span style={{ fontWeight: 400, marginLeft: 6 }}>As semanas deste link foram salvas como base. Suba os CSVs para adicionar a semana nova — as anteriores ficam travadas automaticamente.</span>
              </div>
            )}

            {/* Caixa de link para copiar manualmente */}
            {linkGerado && copied === "manual" && (
              <div style={{ marginBottom: 16, padding: "12px 16px", background: C.cinzaCard, border: `1px solid ${C.laranja}`, borderRadius: 8 }}>
                <p style={{ fontSize: 12, fontWeight: 600, color: C.laranja, marginBottom: 6 }}>📋 Copie o link abaixo (Ctrl+A → Ctrl+C):</p>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    readOnly
                    value={linkGerado}
                    onFocus={e => e.target.select()}
                    style={{ flex: 1, fontSize: 12, padding: "6px 10px", border: `1px solid ${C.cinzaBorda}`, borderRadius: 6, background: C.cinzaFundo, color: C.texto, fontFamily: "monospace" }}
                  />
                  <button onClick={() => { navigator.clipboard.writeText(linkGerado).then(() => { setCopied("done"); setTimeout(() => { setCopied(false); setLinkGerado(null); }, 2000); }); }} style={{ padding: "6px 12px", background: C.laranja, color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
                    Copiar
                  </button>
                  <button onClick={() => { setCopied(false); setLinkGerado(null); }} style={{ padding: "6px 10px", background: C.cinzaBorda, color: C.cinzaTexto, border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12 }}>
                    ✕
                  </button>
                </div>
              </div>
            )}

            {/* Seletor de período — sempre visível em todas as abas */}
            <div style={{ marginBottom: 16, padding: "14px 20px", background: C.cinzaCard, border: `1px solid ${C.cinzaBorda}`, borderRadius: 12 }}>
              {/* Linha 1: Semana/Mês + Modo */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: C.cinzaTexto, flexShrink: 0 }}>📅 Período:</span>
                {["semana", "mes"].map(m => (
                  <button key={m} onClick={() => {
                    setModoPeriodo(m);
                    setPeriodosMulti([]);
                    setPeriodoSelComReset(m === "semana" ? parsed.semanas[parsed.semanas.length - 1] : parsed.meses[parsed.meses.length - 1]);
                  }} style={{
                    padding: "5px 14px", borderRadius: 20, border: `1px solid ${modoPeriodo === m ? C.laranja : C.cinzaBorda}`,
                    background: modoPeriodo === m ? C.laranja : "transparent",
                    color: modoPeriodo === m ? "#fff" : C.cinzaTexto,
                    cursor: "pointer", fontSize: 12, fontWeight: 600,
                  }}>{m === "semana" ? "📆 Semana" : "🗓️ Mês"}</button>
                ))}
                <div style={{ width: 1, height: 18, background: C.cinzaBorda }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: C.cinzaTexto }}>👁️ Visualização:</span>
                {[
                  { id: "unico", label: "Individual" },
                  { id: "consolidar", label: "Consolidar" },
                  { id: "comparar", label: "Comparar" },
                ].map(modo => (
                  <button key={modo.id} onClick={() => { setModoSelecao(modo.id); setPeriodosMulti([]); }} style={{
                    padding: "5px 14px", borderRadius: 20,
                    border: `1px solid ${modoSelecao === modo.id ? C.azul : C.cinzaBorda}`,
                    background: modoSelecao === modo.id ? "#DBEAFE" : "transparent",
                    color: modoSelecao === modo.id ? C.azul : C.cinzaTexto,
                    cursor: "pointer", fontSize: 12, fontWeight: modoSelecao === modo.id ? 700 : 400,
                  }}>
                    {modo.id === "unico" ? "👤 " : modo.id === "consolidar" ? "🔗 " : "⚡ "}{modo.label}
                  </button>
                ))}
                {modoSelecao !== "unico" && periodosMulti.length > 0 && (
                  <span style={{ fontSize: 11, color: C.cinzaTexto, marginLeft: 4, background: C.cinzaFundo, padding: "3px 10px", borderRadius: 20, border: `1px solid ${C.cinzaBorda}` }}>
                    {periodosMulti.length} selecionado{periodosMulti.length > 1 ? "s" : ""}
                    {modoSelecao === "consolidar" ? " — consolidado" : " — comparando"}
                  </span>
                )}
                {modoSelecao !== "unico" && periodosMulti.length === 0 && (
                  <span style={{ fontSize: 11, color: C.amarelo, marginLeft: 4 }}>
                    ← Selecione os períodos abaixo
                  </span>
                )}
              </div>
              {/* Linha 2: Chips de período */}
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {periodos.map(p => {
                  const isUnico = modoSelecao === "unico" && periodoSel === p.val;
                  const isMulti = modoSelecao !== "unico" && periodosMulti.includes(p.val);
                  const ativo = isUnico || isMulti;
                  return (
                    <button key={p.val} onClick={() => {
                      if (modoSelecao === "unico") setPeriodoSelComReset(p.val);
                      else togglePeriodoMulti(p.val);
                    }} style={{
                      padding: "4px 10px", borderRadius: 20, fontSize: 11,
                      border: `1px solid ${ativo ? C.laranja : C.cinzaBorda}`,
                      background: ativo ? C.laranjaLight : "transparent",
                      color: ativo ? C.laranja : C.cinzaTexto,
                      cursor: "pointer", fontWeight: ativo ? 700 : 400,
                    }}>{p.label}</button>
                  );
                })}
                {/* Última semana em andamento (< 10 respostas) — travada */}
                {modoPeriodo === "semana" && parsed.ultimaSemanaEmAndamento && (
                  <span title={`W${parsed.ultimaSemanaRaw} em andamento — ${parsed.ultimaSemanaResp} respostas (mín. 10 para desbloquear)`} style={{
                    padding: "4px 10px", borderRadius: 20, fontSize: 11,
                    border: `1px solid ${C.cinzaBorda}`,
                    background: C.amareloLight,
                    color: C.amarelo,
                    fontWeight: 600,
                    cursor: "not-allowed",
                    opacity: 0.7,
                  }}>🔒 W{parsed.ultimaSemanaRaw} ({parsed.ultimaSemanaResp} resp.)</span>
                )}
              </div>
            </div>

            {/* Tabs */}
            <div style={{ display: "flex", gap: 4, borderBottom: `2px solid ${C.cinzaBorda}`, marginBottom: 24 }}>
              {tabs.map(t => (
                <button key={t.id} onClick={() => setTab(t.id)} style={{
                  padding: "10px 20px", border: "none", background: "transparent", cursor: "pointer",
                  fontSize: 14, fontWeight: tab === t.id ? 700 : 500,
                  color: tab === t.id ? C.laranja : C.cinzaTexto,
                  borderBottom: tab === t.id ? `2px solid ${C.laranja}` : "2px solid transparent",
                  marginBottom: -2,
                }}>{t.label}</button>
              ))}
            </div>

            {/* Filtro por parceiro — aparece nas abas Por Parceiro, Motivos e Comentários */}
            {(tab === "parceiros" || tab === "motivos" || tab === "comentarios") && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: C.cinzaTexto, flexShrink: 0 }}>Filtrar parceiro:</span>
                {parceirosDisponiveis.map(p => (
                  <button key={p} onClick={() => setParceroFiltro(p)} style={{
                    padding: "5px 12px", borderRadius: 20, fontSize: 12,
                    border: `1px solid ${parceroFiltro === p ? C.laranja : C.cinzaBorda}`,
                    background: parceroFiltro === p ? C.laranja : "transparent",
                    color: parceroFiltro === p ? "#fff" : C.cinzaTexto,
                    cursor: "pointer", fontWeight: parceroFiltro === p ? 700 : 400,
                  }}>{p}</button>
                ))}
              </div>
            )}

            {/* VISÃO GERAL */}
            {tab === "overview" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
                  <KpiCard label="Share Notas 4-5" value={periodoAtual.share} format={pct} meta={0.85} badge={periodoAtual.label} />
                  <KpiCard label="Taxa de Resposta" value={periodoAtual.taxa} format={pct} badge={periodoAtual.label} />
                  <KpiCard label="Respostas" value={periodoAtual.respostas} format={v => v} badge={periodoAtual.label} />
                  <KpiCard label="Disparos" value={periodoAtual.disparos} format={v => v} badge={periodoAtual.label} />
                </div>

                {/* Variação vs período anterior */}
                {modoSelecao === "unico" && (() => {
                  const source = modoPeriodo === "semana" ? parsed.porSemana : parsed.porMes;
                  const idx = source.findIndex(p => p === periodoAtual);
                  const anterior = idx > 0 ? source[idx - 1] : null;
                  if (!anterior) return null;
                  const delta = periodoAtual.share !== null && anterior.share !== null ? periodoAtual.share - anterior.share : null;
                  const deltaResp = periodoAtual.respostas - anterior.respostas;

                  // Variação por parceiro
                  const parceirosVars = periodoAtual.parceiros.map(p => {
                    const pAnt = anterior.parceiros.find(x => x.nome === p.nome);
                    if (!pAnt || pAnt.share === null || p.share === null) return null;
                    return { nome: p.nome, atual: p.share, anterior: pAnt.share, delta: p.share - pAnt.share };
                  }).filter(Boolean).sort((a, b) => a.delta - b.delta); // piores primeiro

                  const pioraram = parceirosVars.filter(p => p.delta < -0.01);
                  const melhoraram = parceirosVars.filter(p => p.delta > 0.01);

                  return (
                    <Card>
                      <SecHead>📊 Variação vs {anterior.label}</SecHead>
                      <div style={{ display: "flex", gap: 16, marginBottom: pioraram.length || melhoraram.length ? 16 : 0, flexWrap: "wrap" }}>
                        <div style={{ padding: "10px 18px", background: delta === null ? C.cinzaFundo : delta >= 0 ? C.verdeLight : C.vermelhoLight, borderRadius: 8, textAlign: "center" }}>
                          <div style={{ fontSize: 22, fontWeight: 700, color: delta === null ? C.cinzaTexto : delta >= 0 ? C.verde : C.vermelho }}>
                            {delta === null ? "—" : `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(2)}pp`}
                          </div>
                          <div style={{ fontSize: 11, color: C.cinzaTexto, fontWeight: 600 }}>Share 4-5 {delta !== null ? (delta >= 0 ? "▲" : "▼") : ""}</div>
                        </div>
                        <div style={{ padding: "10px 18px", background: C.cinzaFundo, borderRadius: 8, textAlign: "center" }}>
                          <div style={{ fontSize: 22, fontWeight: 700, color: deltaResp >= 0 ? C.verde : C.amarelo }}>
                            {deltaResp >= 0 ? "+" : ""}{deltaResp}
                          </div>
                          <div style={{ fontSize: 11, color: C.cinzaTexto, fontWeight: 600 }}>Respostas {deltaResp >= 0 ? "▲" : "▼"}</div>
                        </div>
                        <div style={{ padding: "10px 18px", background: C.cinzaFundo, borderRadius: 8, textAlign: "center" }}>
                          <div style={{ fontSize: 22, fontWeight: 700, color: C.cinzaTexto }}>{anterior.label}</div>
                          <div style={{ fontSize: 11, color: C.cinzaTexto, fontWeight: 600 }}>Share anterior: {pct(anterior.share)}</div>
                        </div>
                      </div>

                      {(pioraram.length > 0 || melhoraram.length > 0) && (
                        <div style={{ display: "grid", gridTemplateColumns: pioraram.length && melhoraram.length ? "1fr 1fr" : "1fr", gap: 16 }}>
                          {pioraram.length > 0 && (
                            <div>
                              <p style={{ fontSize: 11, fontWeight: 700, color: C.vermelho, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>🔴 Pioraram</p>
                              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                {pioraram.map((p, i) => (
                                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", borderRadius: 8, background: C.vermelhoLight + "55", border: `1px solid ${C.vermelho}22` }}>
                                    <span style={{ fontSize: 12, fontWeight: 700, flex: 1 }}>{p.nome}</span>
                                    <span style={{ fontSize: 11, color: C.cinzaTexto }}>{pct(p.anterior)}</span>
                                    <span style={{ fontSize: 11, color: C.cinzaTexto }}>→</span>
                                    <span style={{ fontSize: 12, fontWeight: 700, color: p.atual < 0.85 ? C.vermelho : C.texto }}>{pct(p.atual)}</span>
                                    <span style={{ fontSize: 11, fontWeight: 700, color: C.vermelho, background: C.vermelhoLight, borderRadius: 20, padding: "1px 8px" }}>
                                      {(p.delta * 100).toFixed(1)}pp ▼
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {melhoraram.length > 0 && (
                            <div>
                              <p style={{ fontSize: 11, fontWeight: 700, color: C.verde, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>🟢 Melhoraram</p>
                              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                {melhoraram.map((p, i) => (
                                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", borderRadius: 8, background: C.verdeLight + "55", border: `1px solid ${C.verde}22` }}>
                                    <span style={{ fontSize: 12, fontWeight: 700, flex: 1 }}>{p.nome}</span>
                                    <span style={{ fontSize: 11, color: C.cinzaTexto }}>{pct(p.anterior)}</span>
                                    <span style={{ fontSize: 11, color: C.cinzaTexto }}>→</span>
                                    <span style={{ fontSize: 12, fontWeight: 700, color: p.atual < 0.85 ? C.amarelo : C.verde }}>{pct(p.atual)}</span>
                                    <span style={{ fontSize: 11, fontWeight: 700, color: C.verde, background: C.verdeLight, borderRadius: 20, padding: "1px 8px" }}>
                                      +{(p.delta * 100).toFixed(1)}pp ▲
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </Card>
                  );
                })()}

                {/* Distribuição notas */}
                <Card>
                  <SecHead>Distribuição de Notas — {periodoAtual.label}</SecHead>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end", height: 80 }}>
                    {[1,2,3,4,5].map(n => {
                      const qtd = periodoAtual.parceiros.reduce((acc, p) => acc + (p.notas.find(x => x.nota === n)?.qtd || 0), 0);
                      const h = periodoAtual.respostas ? (qtd / periodoAtual.respostas) * 60 + 8 : 8;
                      return (
                        <div key={n} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: C.cinzaTexto }}>{qtd}</span>
                          <div style={{ width: "100%", height: h, borderRadius: 4, background: n >= 4 ? C.verde : n === 3 ? C.amarelo : C.vermelho }} />
                          <span style={{ fontSize: 12, fontWeight: 700, color: C.cinzaTexto }}>★{n}</span>
                        </div>
                      );
                    })}
                  </div>
                </Card>

                {/* Histórico */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                  <Card>
                    <SecHead>Share 4-5 — histórico por {modoPeriodo} (meta 85%)</SecHead>
                    <ResponsiveContainer width="100%" height={160}>
                      <LineChart data={historico} margin={{ top: 8, right: 8, left: -20, bottom: 4 }}>
                        <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                        <YAxis tickFormatter={v => (v*100).toFixed(0)+"%"} domain={[0.7,1]} tick={{ fontSize: 10 }} />
                        <Tooltip formatter={v => pct(v)} contentStyle={{ fontSize: 11, background: C.texto, color: "#fff", border: "none", borderRadius: 6 }} />
                        <ReferenceLine y={0.85} stroke={C.vermelho} strokeDasharray="4 2" />
                        <Line type="monotone" dataKey="share" stroke={C.verde} strokeWidth={2} dot={{ r: 3 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </Card>
                  <Card>
                    <SecHead>Taxa de Resposta — histórico por {modoPeriodo}</SecHead>
                    <ResponsiveContainer width="100%" height={160}>
                      <BarChart data={historico} margin={{ top: 8, right: 8, left: -20, bottom: 4 }}>
                        <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                        <YAxis tickFormatter={v => (v*100).toFixed(0)+"%"} tick={{ fontSize: 10 }} />
                        <Tooltip formatter={v => pct(v)} contentStyle={{ fontSize: 11, background: C.texto, color: "#fff", border: "none", borderRadius: 6 }} />
                        <Bar dataKey="taxa" radius={[4,4,0,0]}>
                          {historico.map((_, i) => <Cell key={i} fill={C.laranja} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </Card>
                </div>
              </div>
            )}

            {/* POR PARCEIRO */}
            {tab === "parceiros" && (
              <Card>
                <SecHead>CSAT por Parceiro — {periodoFiltrado.label}{parceroFiltro !== "Todos" ? ` · ${parceroFiltro}` : ""} (meta 85%)</SecHead>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead><tr style={{ borderBottom: `2px solid ${C.cinzaBorda}` }}>
                    {["Parceiro","Share 4-5","Respostas","★1","★2","★3","★4","★5"].map(h => (
                      <th key={h} style={{ padding: "8px 12px", textAlign: h==="Parceiro"?"left":"center", color: C.cinzaTexto, fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {periodoFiltrado.parceiros.map((p, i) => {
                      const crit = p.share !== null && p.share < 0.85;
                      return (
                        <tr key={i} style={{ borderBottom: `1px solid ${C.cinzaBorda}`, background: crit ? C.vermelhoLight+"44" : "transparent" }}>
                          <td style={{ padding: "9px 12px", fontWeight: 600 }}>{p.nome}</td>
                          <td style={{ padding: "9px 12px", textAlign: "center" }}>
                            <span style={{ display:"inline-block", padding:"2px 10px", borderRadius:20, fontWeight:700, background: crit?C.vermelhoLight:C.verdeLight, color: crit?C.vermelho:C.verde }}>{pct(p.share)}</span>
                          </td>
                          <td style={{ padding: "9px 12px", textAlign: "center", color: C.cinzaTexto }}>{p.respostas}</td>
                          {[1,2,3,4,5].map(n => {
                            const qtd = p.notas.find(x=>x.nota===n)?.qtd||0;
                            return <td key={n} style={{ padding:"9px 12px", textAlign:"center", color: n<=3&&qtd>0?C.vermelho:C.cinzaTexto, fontWeight: n<=3&&qtd>0?700:400 }}>{qtd}</td>;
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Card>
            )}

            {/* MOTIVOS 1-3 */}
            {tab === "motivos" && (
              <Card>
                <SecHead>Dimensões com mais notas 1-3 — {periodoFiltrado.label}{parceroFiltro !== "Todos" ? ` · ${parceroFiltro}` : ""}</SecHead>
                {periodoFiltrado.motivos.filter(m => m.count > 0).length === 0 ? (
                  <p style={{ fontSize: 14, color: C.cinzaTexto }}>Nenhuma nota 1-3 neste período. 🎉</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {periodoFiltrado.motivos.map((m, i) => {
                      const max = periodoFiltrado.motivos[0].count;
                      const w = max ? (m.count / max) * 100 : 0;
                      return (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, width: 210, flexShrink: 0 }}>{m.label}</span>
                          <div style={{ flex: 1, background: C.cinzaBorda, borderRadius: 4, height: 20, position: "relative" }}>
                            <div style={{ width: `${w}%`, background: m.count > 10 ? C.vermelho : C.amarelo, height: "100%", borderRadius: 4 }} />
                          </div>
                          <span style={{ fontSize: 13, fontWeight: 700, color: m.count > 10 ? C.vermelho : C.amarelo, width: 30, textAlign: "right" }}>{m.count}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
            )}

            {/* COMENTÁRIOS */}
            {tab === "comentarios" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

                {/* Resumo de críticas */}
                {periodoFiltrado.comentariosNeg.length > 0 && (() => {
                  // Agrupar críticas por palavras-chave nos comentários
                  const temas = [
                    { label: "Atraso / Não compareceu", palavras: ["atraso", "atrasou", "não veio", "nao veio", "não apareceu", "nao apareceu", "não compareceu", "nao compareceu", "desmarcou", "cancelou"] },
                    { label: "Reagendamento / Demora", palavras: ["reagend", "remarc", "demora", "demorou", "espera", "dias"] },
                    { label: "Comunicação / Contato", palavras: ["ligo", "ligou", "não liga", "nao liga", "contato", "whatsapp", "mensagem", "comunicação", "avisar", "avisou"] },
                    { label: "Postura / Atendimento", palavras: ["grosso", "grosseria", "mal educado", "maleducado", "rude", "desrespeit", "postura", "atendimento ruim"] },
                    { label: "Coleta não realizada", palavras: ["não coletou", "nao coletou", "não pegou", "nao pegou", "não retirou", "nao retirou", "não buscou", "nao buscou"] },
                    { label: "Produto danificado", palavras: ["danificou", "quebrou", "amassou", "arranhado", "dano", "estrago"] },
                  ];

                  const temasContagem = temas.map(t => {
                    const matches = periodoFiltrado.comentariosNeg.filter(c =>
                      t.palavras.some(p => c.comentario.toLowerCase().includes(p))
                    );
                    return { label: t.label, count: matches.length, parceiros: [...new Set(matches.map(c => c.transp))] };
                  }).filter(t => t.count > 0).sort((a, b) => b.count - a.count);

                  // Resumo por parceiro
                  const parceirosComCriticas = [...new Set(periodoFiltrado.comentariosNeg.map(c => c.transp))].map(nome => {
                    const coms = periodoFiltrado.comentariosNeg.filter(c => c.transp === nome);
                    const totalParceiro = (periodoFiltrado.parceiros.find(p => p.nome === nome)?.respostas) || coms.length;
                    return { nome, criticas: coms.length, pct: totalParceiro ? ((coms.length / totalParceiro) * 100).toFixed(1) : "—" };
                  }).sort((a, b) => b.criticas - a.criticas);

                  return (
                    <>
                      {/* Card resumo geral */}
                      <Card>
                        <SecHead>📋 Resumo de Críticas — {periodoFiltrado.label}{parceroFiltro !== "Todos" ? ` · ${parceroFiltro}` : ""}</SecHead>
                        <div style={{ display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
                          <div style={{ padding: "10px 18px", background: C.vermelhoLight, borderRadius: 8, textAlign: "center" }}>
                            <div style={{ fontSize: 24, fontWeight: 700, color: C.vermelho }}>{periodoFiltrado.comentariosNeg.length}</div>
                            <div style={{ fontSize: 11, color: C.cinzaTexto, fontWeight: 600 }}>Críticas (notas 1-3)</div>
                          </div>
                          <div style={{ padding: "10px 18px", background: C.verdeLight, borderRadius: 8, textAlign: "center" }}>
                            <div style={{ fontSize: 24, fontWeight: 700, color: C.verde }}>{periodoFiltrado.comentariosPos.length}</div>
                            <div style={{ fontSize: 11, color: C.cinzaTexto, fontWeight: 600 }}>Elogios (notas 4-5)</div>
                          </div>
                          {periodoFiltrado.respostas > 0 && (
                            <div style={{ padding: "10px 18px", background: C.amareloLight, borderRadius: 8, textAlign: "center" }}>
                              <div style={{ fontSize: 24, fontWeight: 700, color: C.amarelo }}>
                                {((periodoFiltrado.comentariosNeg.length / periodoFiltrado.respostas) * 100).toFixed(1)}%
                              </div>
                              <div style={{ fontSize: 11, color: C.cinzaTexto, fontWeight: 600 }}>das respostas são críticas</div>
                            </div>
                          )}
                        </div>

                        {temasContagem.length > 0 && (
                          <>
                            <p style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: C.cinzaTexto, marginBottom: 10 }}>🔍 Principais Temas Críticos</p>
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                              {temasContagem.map((t, i) => (
                                <div key={i} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                  <span style={{ fontSize: 12, fontWeight: 600, width: 220, flexShrink: 0 }}>{t.label}</span>
                                  <div style={{ flex: 1, background: C.cinzaBorda, borderRadius: 4, height: 18, position: "relative" }}>
                                    <div style={{ width: `${(t.count / temasContagem[0].count) * 100}%`, background: i === 0 ? C.vermelho : C.amarelo, height: "100%", borderRadius: 4 }} />
                                  </div>
                                  <span style={{ fontSize: 12, fontWeight: 700, color: i === 0 ? C.vermelho : C.amarelo, width: 28, textAlign: "right" }}>{t.count}</span>
                                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap", minWidth: 0 }}>
                                    {t.parceiros.slice(0, 3).map((p, j) => (
                                      <span key={j} style={{ fontSize: 10, background: C.laranjaLight, color: C.laranja, borderRadius: 20, padding: "1px 7px", fontWeight: 600, whiteSpace: "nowrap" }}>{p}</span>
                                    ))}
                                    {t.parceiros.length > 3 && <span style={{ fontSize: 10, color: C.cinzaTexto }}>+{t.parceiros.length - 3}</span>}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </>
                        )}
                      </Card>

                      {/* Resumo por parceiro */}
                      {parceroFiltro === "Todos" && parceirosComCriticas.length > 0 && (
                        <Card>
                          <SecHead>⚠️ Críticas por Parceiro — {periodoFiltrado.label}</SecHead>
                          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            {parceirosComCriticas.map((p, i) => (
                              <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", borderRadius: 8, background: i === 0 ? C.vermelhoLight + "55" : C.cinzaFundo, border: `1px solid ${i === 0 ? C.vermelho + "44" : C.cinzaBorda}` }}>
                                <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>{p.nome}</span>
                                <span style={{ fontSize: 12, fontWeight: 700, color: C.vermelho, background: C.vermelhoLight, borderRadius: 20, padding: "2px 10px" }}>{p.criticas} crítica{p.criticas !== 1 ? "s" : ""}</span>
                                <span style={{ fontSize: 12, color: C.cinzaTexto, width: 60, textAlign: "right" }}>{p.pct}% das resp.</span>
                              </div>
                            ))}
                          </div>
                        </Card>
                      )}
                    </>
                  );
                })()}

                {/* Listas de comentários — 5 por parceiro quando filtro = Todos, normal quando filtrado */}
                {parceroFiltro !== "Todos" ? (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                    <Card>
                      <SecHead>🔴 Comentários Negativos ({periodoFiltrado.comentariosNeg.length})</SecHead>
                      {periodoFiltrado.comentariosNeg.length === 0
                        ? <p style={{ fontSize: 13, color: C.cinzaTexto }}>Nenhum comentário negativo.</p>
                        : <ComentariosList items={periodoFiltrado.comentariosNeg} />}
                    </Card>
                    <Card>
                      <SecHead>🟢 Comentários Positivos ({periodoFiltrado.comentariosPos.length})</SecHead>
                      {periodoFiltrado.comentariosPos.length === 0
                        ? <p style={{ fontSize: 13, color: C.cinzaTexto }}>Nenhum comentário positivo.</p>
                        : <ComentariosList items={periodoFiltrado.comentariosPos} />}
                    </Card>
                  </div>
                ) : (
                  <Card>
                    <SecHead>💬 Comentários por Parceiro — {periodoFiltrado.label} (até 5 por parceiro)</SecHead>
                    {(() => {
                      const parceirosComComentarios = [...new Set([
                        ...periodoFiltrado.comentariosNeg.map(c => c.transp),
                        ...periodoFiltrado.comentariosPos.map(c => c.transp),
                      ])].sort();
                      if (parceirosComComentarios.length === 0) return <p style={{ fontSize: 13, color: C.cinzaTexto }}>Nenhum comentário neste período.</p>;
                      return (
                        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                          {parceirosComComentarios.map(nome => {
                            const negs = periodoFiltrado.comentariosNeg.filter(c => c.transp === nome).slice(0, 5);
                            const pos = periodoFiltrado.comentariosPos.filter(c => c.transp === nome).slice(0, 5);
                            const totalNegs = periodoFiltrado.comentariosNeg.filter(c => c.transp === nome).length;
                            const totalPos = periodoFiltrado.comentariosPos.filter(c => c.transp === nome).length;
                            return (
                              <div key={nome}>
                                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                                  <span style={{ fontSize: 13, fontWeight: 700, color: C.texto }}>{nome}</span>
                                  {totalNegs > 0 && <span style={{ fontSize: 11, background: C.vermelhoLight, color: C.vermelho, borderRadius: 20, padding: "1px 8px", fontWeight: 600 }}>🔴 {totalNegs} crítica{totalNegs !== 1 ? "s" : ""}</span>}
                                  {totalPos > 0 && <span style={{ fontSize: 11, background: C.verdeLight, color: C.verde, borderRadius: 20, padding: "1px 8px", fontWeight: 600 }}>🟢 {totalPos} elogio{totalPos !== 1 ? "s" : ""}</span>}
                                </div>
                                <div style={{ display: "grid", gridTemplateColumns: negs.length && pos.length ? "1fr 1fr" : "1fr", gap: 12 }}>
                                  {negs.length > 0 && (
                                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                                      {negs.map((c, i) => (
                                        <div key={i} style={{ display: "flex", gap: 8, padding: "8px 10px", background: C.cinzaFundo, borderRadius: 7, borderLeft: `3px solid ${C.vermelho}` }}>
                                          <span style={{ fontSize: 11, fontWeight: 700, color: C.vermelho, flexShrink: 0 }}>★{c.nota}</span>
                                          {c.semana && <span style={{ fontSize: 11, color: C.cinzaTexto, flexShrink: 0 }}>W{c.semana}</span>}
                                          <span style={{ fontSize: 12, color: C.texto, lineHeight: 1.4 }}>{c.comentario}</span>
                                        </div>
                                      ))}
                                      {totalNegs > 5 && <span style={{ fontSize: 11, color: C.cinzaTexto, paddingLeft: 4 }}>+{totalNegs - 5} críticas — filtre por parceiro para ver todas</span>}
                                    </div>
                                  )}
                                  {pos.length > 0 && (
                                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                                      {pos.map((c, i) => (
                                        <div key={i} style={{ display: "flex", gap: 8, padding: "8px 10px", background: C.cinzaFundo, borderRadius: 7, borderLeft: `3px solid ${C.verde}` }}>
                                          <span style={{ fontSize: 11, fontWeight: 700, color: C.verde, flexShrink: 0 }}>★{c.nota}</span>
                                          {c.semana && <span style={{ fontSize: 11, color: C.cinzaTexto, flexShrink: 0 }}>W{c.semana}</span>}
                                          <span style={{ fontSize: 12, color: C.texto, lineHeight: 1.4 }}>{c.comentario}</span>
                                        </div>
                                      ))}
                                      {totalPos > 5 && <span style={{ fontSize: 11, color: C.cinzaTexto, paddingLeft: 4 }}>+{totalPos - 5} elogios — filtre por parceiro para ver todos</span>}
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </Card>
                )}
              </div>
            )}
            {/* COMPARAÇÃO */}
            {tab === "comparar" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                {periodosAtivos.length < 2 ? (
                  <div style={{ textAlign: "center", padding: "48px", color: C.cinzaTexto, background: C.cinzaCard, borderRadius: 12, border: `1px solid ${C.cinzaBorda}` }}>
                    <div style={{ fontSize: 40, marginBottom: 12 }}>⚡</div>
                    <p style={{ fontSize: 15, fontWeight: 600, color: C.texto, marginBottom: 6 }}>Modo Comparação</p>
                    <p style={{ fontSize: 13, color: C.cinzaTexto }}>Selecione pelo menos <strong>2 períodos</strong> nos chips acima para comparar</p>
                    <p style={{ fontSize: 12, color: C.cinzaTexto, marginTop: 8 }}>Você tem <strong>{periodosAtivos.length}</strong> período{periodosAtivos.length !== 1 ? "s" : ""} selecionado{periodosAtivos.length !== 1 ? "s" : ""}</p>
                  </div>
                ) : (
                  <>
                    {/* KPIs comparativos */}
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                          <tr style={{ borderBottom: `2px solid ${C.cinzaBorda}` }}>
                            <th style={{ padding: "8px 14px", textAlign: "left", color: C.cinzaTexto, fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>Indicador</th>
                            {periodosAtivos.map(p => (
                              <th key={p.label} style={{ padding: "8px 14px", textAlign: "center", color: C.laranja, fontWeight: 700, fontSize: 12 }}>{p.label}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {[
                            { label: "Share 4-5", fn: p => pct(p.share), meta: 0.85, val: p => p.share },
                            { label: "Taxa Resposta", fn: p => pct(p.taxa), val: p => p.taxa },
                            { label: "Respostas", fn: p => p.respostas, val: p => p.respostas },
                            { label: "Disparos", fn: p => p.disparos, val: p => p.disparos },
                          ].map((row, ri) => {
                            const vals = periodosAtivos.map(p => row.val(p));
                            const max = Math.max(...vals.filter(v => v !== null));
                            const min = Math.min(...vals.filter(v => v !== null));
                            return (
                              <tr key={ri} style={{ borderBottom: `1px solid ${C.cinzaBorda}` }}>
                                <td style={{ padding: "9px 14px", fontWeight: 600, color: C.texto }}>{row.label}</td>
                                {periodosAtivos.map((p, i) => {
                                  const v = row.val(p);
                                  const isBest = v === max && max !== min;
                                  const isWorst = v === min && max !== min;
                                  return (
                                    <td key={i} style={{ padding: "9px 14px", textAlign: "center", fontWeight: isBest || isWorst ? 700 : 400, color: isBest ? C.verde : isWorst ? C.vermelho : C.texto, background: isBest ? C.verdeLight + "44" : isWorst ? C.vermelhoLight + "44" : "transparent" }}>
                                      {row.fn(p)}
                                      {isBest && <span style={{ fontSize: 10, marginLeft: 4 }}>▲</span>}
                                      {isWorst && <span style={{ fontSize: 10, marginLeft: 4 }}>▼</span>}
                                    </td>
                                  );
                                })}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Parceiros comparativos */}
                    <Card>
                      <SecHead>Share 4-5 por Parceiro — comparação</SecHead>
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                          <thead>
                            <tr style={{ borderBottom: `2px solid ${C.cinzaBorda}` }}>
                              <th style={{ padding: "7px 12px", textAlign: "left", color: C.cinzaTexto, fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>Parceiro</th>
                              {periodosAtivos.map(p => (
                                <th key={p.label} style={{ padding: "7px 12px", textAlign: "center", color: C.laranja, fontWeight: 700 }}>{p.label}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {[...new Set(periodosAtivos.flatMap(p => p.parceiros.map(pa => pa.nome)))].sort().map((nome, i) => (
                              <tr key={i} style={{ borderBottom: `1px solid ${C.cinzaBorda}` }}>
                                <td style={{ padding: "7px 12px", fontWeight: 600 }}>{nome}</td>
                                {periodosAtivos.map((p, j) => {
                                  const pa = p.parceiros.find(x => x.nome === nome);
                                  const share = pa?.share ?? null;
                                  const crit = share !== null && share < 0.85;
                                  return (
                                    <td key={j} style={{ padding: "7px 12px", textAlign: "center" }}>
                                      {share !== null ? (
                                        <span style={{ display: "inline-block", padding: "1px 8px", borderRadius: 20, fontSize: 11, fontWeight: 700, background: crit ? C.vermelhoLight : C.verdeLight, color: crit ? C.vermelho : C.verde }}>{pct(share)}</span>
                                      ) : <span style={{ color: C.cinzaBorda }}>—</span>}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </Card>

                    {/* Motivos comparativos */}
                    <Card>
                      <SecHead>Motivos 1-3 — comparação</SecHead>
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                          <thead>
                            <tr style={{ borderBottom: `2px solid ${C.cinzaBorda}` }}>
                              <th style={{ padding: "7px 12px", textAlign: "left", color: C.cinzaTexto, fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>Dimensão</th>
                              {periodosAtivos.map(p => (
                                <th key={p.label} style={{ padding: "7px 12px", textAlign: "center", color: C.laranja, fontWeight: 700 }}>{p.label}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {[...new Set(periodosAtivos.flatMap(p => p.motivos.map(m => m.label)))].map((label, i) => (
                              <tr key={i} style={{ borderBottom: `1px solid ${C.cinzaBorda}` }}>
                                <td style={{ padding: "7px 12px", fontWeight: 600 }}>{label}</td>
                                {periodosAtivos.map((p, j) => {
                                  const m = p.motivos.find(x => x.label === label);
                                  const count = m?.count ?? 0;
                                  return (
                                    <td key={j} style={{ padding: "7px 12px", textAlign: "center", color: count > 10 ? C.vermelho : count > 0 ? C.amarelo : C.cinzaTexto, fontWeight: count > 5 ? 700 : 400 }}>
                                      {count}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </Card>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
