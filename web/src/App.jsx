import React, { useEffect, useRef, useState } from 'react';
import { Code2, Download, RotateCcw, ScanLine } from 'lucide-react';
import { endpoint, getJson } from './api.js';
import { CaseRail, Contracts, GroupInspector, History, Outcomes, PythonDrawer, TraceTable, WalkthroughBar } from './components.jsx';

export default function App() {
  const [bootstrap, setBootstrap] = useState(null);
  const [model, setModel] = useState('letter-openai-2025');
  const [cutoff, setCutoff] = useState(10);
  const [query, setQuery] = useState(145);
  const [category, setCategory] = useState('all');
  const [rows, setRows] = useState([]);
  const [result, setResult] = useState(null);
  const [policy, setPolicy] = useState('history_cosine');
  const [rank, setRank] = useState(1);
  const [showCode, setShowCode] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {document.title = 'Cornac Workbench · Recommendation diagnostics';}, []);

  useEffect(() => {
    const controller = new AbortController();
    getJson('/api/bootstrap', {signal: controller.signal}).then(setBootstrap).catch(e => {
      if (e.name !== 'AbortError') setError(e.message);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    getJson(endpoint('queries', {model, cutoff, category}), {signal: controller.signal})
      .then(data => setRows(data.queries)).catch(e => {if (e.name !== 'AbortError') setError(e.message);});
    return () => controller.abort();
  }, [model, cutoff, category]);

  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    getJson(endpoint('query', {query, model, cutoff}), {signal: controller.signal}).then(data => {
      setResult(data);
      setRank(1);
      setBusy(false);
    }).catch(e => {if (e.name !== 'AbortError') {setError(e.message); setBusy(false);}});
    return () => controller.abort();
  }, [query, model, cutoff]);

  async function replay(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setNotice('Checking exported session…');
    try {
      const response = await getJson('/api/replay', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: await file.text()});
      const replayed = response.result;
      setQuery(replayed.query_index);
      setModel(replayed.model_id);
      setCutoff(replayed.cutoff);
      setCategory('all');
      setNotice(`Replay passed · query #${replayed.query_index} · both resolver results reconstructed and checksum verified.`);
    } catch (e) {setNotice(`Replay failed: ${e.message}`);}
    event.target.value = '';
  }

  function handleSelectTask(task) {
    setCategory('all');
    setQuery(task.query);
    setModel(task.model);
    setCutoff(task.cutoff);
    setPolicy(task.policy);
    setNotice('');
  }

  const current = result && result.query_index === query && result.model_id === model && result.cutoff === cutoff;
  const selectedModel = bootstrap?.models[model];
  const selectedSlot = current ? result.policies[policy].slots.find(slot => slot.rank === rank) : null;

  return <>
    <a className="skip-link" href="#diagnostics">Skip to diagnostics</a>
    <header className="app-header">
      <div className="brand">
        <ScanLine className="brand-mark" size={25} aria-hidden="true"/>
        <span>Cornac <span className="brand-workbench">Workbench</span></span>
        <a className="preferred-signature" href="https://preferred.ai/" target="_blank" rel="noreferrer">by <strong>PreferredAI<span>.</span></strong></a>
      </div>
      <div className="header-actions">
        <a className="button" href="/">Beauty journeys</a>
        <input ref={fileRef} type="file" accept="application/json,.json" onChange={replay} hidden aria-label="Session file"/>
        <button
          type="button"
          className={`button ${showCode ? 'active-btn' : ''}`}
          aria-expanded={showCode}
          data-testid="toggle-code"
          onClick={() => setShowCode(!showCode)}
        >
          <Code2 size={16}/>Python API
        </button>
        <button className="button" onClick={() => fileRef.current.click()}><RotateCcw size={16}/>Replay session</button>
        <a className="button primary" href={endpoint('export', {query, model, cutoff})} download data-testid="export"><Download size={16}/>Export session</a>
      </div>
    </header>
    <div className="app-layout">
      <CaseRail rows={rows} query={query} category={category} setCategory={setCategory} setQuery={id => {setQuery(id); setNotice('');}}/>
      <main id="diagnostics" tabIndex={-1}>
        <div className="workspace-intro">
          <div><h1>Recommendation diagnostics</h1><p>Follow a prediction from history to recommendation.</p></div>
          <span className="dataset-context">Amazon Beauty <span>·</span> 18 selected cases</span>
        </div>
        <WalkthroughBar query={query} model={model} cutoff={cutoff} policy={policy} onSelectTask={handleSelectTask}/>
        <div className="toolbar">
          <span className="toolbar-title">Configuration</span>
          <label>Model<select aria-label="Model" value={model} onChange={e => setModel(e.target.value)}>
            <option value="letter-openai-2025">LETTER</option><option value="tiger-openai-2025">TIGER</option>
          </select></label>
          <span className="subtle">OpenAI · seed 2025 · {model.startsWith('tiger') ? 'injective control' : '570 collision groups'}</span>
          <label>Cutoff<select aria-label="Cutoff" value={cutoff} onChange={e => setCutoff(Number(e.target.value))}>
            {[5, 10, 20].map(k => <option key={k} value={k}>Top {k}</option>)}
          </select></label>
          <span className="execution">Saved predictions · runtime resolution</span>
        </div>
        <PythonDrawer open={showCode} model={model} cutoff={cutoff} policy={policy} query={query} onClose={() => setShowCode(false)}/>
        {error ? <div className="message error" role="alert">{error}</div> : null}
        {notice ? <div className="message" role="status">{notice}<button aria-label="Dismiss message" onClick={() => setNotice('')}>×</button></div> : null}
        {!current || !bootstrap ? <div className="loading" role="status">Loading matched query…</div> :
          <div className={busy ? 'workspace busy' : 'workspace'} aria-busy={busy}>
            <section className="workflow-section" aria-labelledby="context-heading">
              <div className="workflow-heading"><span>01</span><div><h2 id="context-heading">Query context</h2><p>The observed history and held-out target for this case.</p></div></div>
              <History result={result}/>
            </section>
            <section className="workflow-section" aria-labelledby="comparison-heading">
              <div className="workflow-heading"><span>02</span><div><h2 id="comparison-heading">Compare recommendations</h2><p>Two member resolvers and a matched sequential baseline.</p></div></div>
              <Outcomes result={result} policy={policy} setPolicy={setPolicy}/>
            </section>
            <section className="workflow-section" aria-labelledby="inspection-heading">
              <div className="workflow-heading"><span>03</span><div><h2 id="inspection-heading">Inspect the decision</h2><p>Select a native prediction to explore its collision group and member scores.</p></div></div>
              <div className="inspector-layout">
                <TraceTable result={result} policy={policy} rank={rank} setRank={setRank}/>
                <GroupInspector key={`${query}-${model}-${rank}-${policy}`} result={result} policy={policy} setPolicy={setPolicy} slot={selectedSlot}/>
              </div>
            </section>
            <Contracts bootstrap={bootstrap} model={selectedModel} result={result}/>
          </div>}
      </main>
    </div>
  </>;
}
