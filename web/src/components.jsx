import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Check, Copy, Target, Search, X } from 'lucide-react';
import { buildPythonSnippet, caseLabel, caseTone, endpoint, getJson, itemName, metric, policyLabels, walkthroughTasks } from './api.js';

const categories = [
  ['all', 'All cases (18)'],
  ['resolver_disagreement', 'Resolver disagreement'],
  ['sid_hit_item_miss', 'SID hit · item miss'],
  ['target_sid_absent', 'Target SID absent'],
  ['collided_target', 'Collided target'],
  ['invalid_outputs', 'Invalid outputs'],
  ['repeated_outputs', 'Repeated outputs'],
];

export function WalkthroughBar({query, model, cutoff, policy, onSelectTask}) {
  return (
    <section className="walkthrough-bar" aria-label="Guided diagnostic walkthrough">
      <div className="walkthrough-head">
        <span className="walkthrough-kicker">Guided scenarios</span>
        <span className="walkthrough-hint">Start with a research question</span>
      </div>
      <div className="walkthrough-steps">
        {walkthroughTasks.map(task => {
          const active = query === task.query && model === task.model && (task.id !== 'task-2b' ? (task.id === 'task-2a' ? policy === 'history_cosine' : true) : policy === 'popularity');
          return (
            <button
              key={task.id}
              type="button"
              className={`walkthrough-step ${active ? 'active' : ''}`}
              data-testid={task.id}
              aria-pressed={active}
              onClick={() => onSelectTask(task)}
            >
              <span className="step-badge" aria-label={task.step}>{task.step.replace('Task ', '')}</span>
              <strong>{task.title}</strong>
              <small>{task.subtitle}</small>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function PythonDrawer({open, model, cutoff, policy, query, onClose}) {
  const [copied, setCopied] = useState(false);
  if (!open) return null;
  const code = buildPythonSnippet({model, cutoff, policy, query});
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  }
  return (
    <section className="panel python-drawer" aria-label="Cornac Python API snippet" data-testid="python-drawer">
      <div className="python-drawer-head">
        <div>
          <h2>Cornac 3.0 Unified Python Experiment</h2>
          <p>Equivalent Python pipeline for {model.startsWith('tiger') ? 'TIGER' : 'LETTER'}, SASRec, and TransformerRec under <code>NextItemEvaluation(semantic_id_metrics=True)</code>.</p>
        </div>
        <div className="python-drawer-actions">
          <button type="button" className="button small" onClick={copyCode} data-testid="copy-code">
            {copied ? <><Check size={14}/>Copied</> : <><Copy size={14}/>Copy Python</>}
          </button>
          <button type="button" className="button small" onClick={onClose} aria-label="Close Python snippet">
            <X size={14}/>Close
          </button>
        </div>
      </div>
      <pre className="python-code"><code>{code}</code></pre>
    </section>
  );
}

export function CaseRail({rows, query, category, setCategory, setQuery}) {
  const nav = useRef(null);
  useLayoutEffect(() => {
    const selected = nav.current?.querySelector('[aria-current="true"]');
    if (selected && window.matchMedia('(max-width: 700px)').matches) {
      nav.current.scrollLeft = selected.offsetLeft - nav.current.offsetLeft - 8;
    }
  }, [rows, query]);
  return (
    <aside className="case-rail" aria-label="Walkthrough cases">
      <div className="case-rail-header">
        <h2>Cases</h2>
        <p>18 selected walkthrough cases</p>
      </div>
      <select aria-label="Case filter" value={category} onChange={e => setCategory(e.target.value)}>
        {categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <nav ref={nav} className="case-list" aria-label="Query selection">
        {rows.map(row => (
          <button
            key={row.query_index}
            aria-current={row.query_index === query ? 'true' : undefined}
            onClick={() => setQuery(row.query_index)}
            data-testid={`query-${row.query_index}`}
          >
            <span className="case-id">#{row.query_index}</span>
            <span className={`case-tag ${caseTone(row)}`}>{caseLabel(row)}</span>
            <span className="case-dots" aria-hidden="true" title={`SID: ${row.sid_hit ? 'Hit' : 'Miss'} · Cos: ${row.history_cosine_hit ? 'Hit' : 'Miss'} · Pop: ${row.popularity_hit ? 'Hit' : 'Miss'}`}>
              <i className={row.sid_hit ? 'dot hit-sid' : 'dot'}/>
              <i className={row.history_cosine_hit ? 'dot hit-cos' : 'dot'}/>
              <i className={row.popularity_hit ? 'dot hit-pop' : 'dot'}/>
            </span>
          </button>
        ))}
      </nav>
      {!rows.length ? <p className="empty">No selected cases match this filter.</p> : null}
      {rows.length && !rows.some(row => row.query_index === query) ? (
        <p className="filter-note">Current query is outside this filter. Select a listed case to switch.</p>
      ) : null}
      <div className="rail-legend" aria-hidden="true">
        <span><i className="dot hit-sid"/>SID</span>
        <span><i className="dot hit-cos"/>Cosine</span>
        <span><i className="dot hit-pop"/>Pop</span>
      </div>
      <p className="scope-note">Diagnostic selection, not a model-quality benchmark.</p>
    </aside>
  );
}

export function History({result}) {
  const [expanded, setExpanded] = useState(false);
  const history = result.history_item_indices;
  const visible = expanded ? history : history.slice(-4);
  const startStep = expanded ? 1 : Math.max(1, history.length - visible.length + 1);
  const target = result.items[String(result.target_item_index)];
  const tc = result.target_context;
  return (
    <section className="panel history-panel" aria-label="Matched history">
      <div className="history-events">
        <div className="section-heading">
          <h2 data-testid="query-heading">Query #{result.query_index}</h2>
          <span>{history.length} visible events</span>
          <span className="context-window-badge">
            Context: {result.effective_history_item_indices.length}/20 SID · {result.sasrec.effective_history_item_indices.length}/50 SASRec
          </span>
        </div>
        <ol className="history-flow">
          {visible.map((index, position) => (
            <li key={`${index}-${position}`} title={`${itemName(result.items, index)} (${result.items[String(index)]?.item_id || index})`}>
              <em className="step-num">#{startStep + position}</em>
              <span>{itemName(result.items, index)}</span>
              <ChevronRight size={13}/>
            </li>
          ))}
        </ol>
        <button className="text-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show recent events' : `View all ${history.length} events`}
          <ChevronDown size={13}/>
        </button>
      </div>
      <div className="held-out">
        <div className="held-out-head">
          <span>Held-out target (ground truth)</span>
          <code>{target.item_id}</code>
        </div>
        <strong>{target.title}</strong>
        {tc ? (
          <div className="target-context-strip">
            <span className="target-sid-pill" title="Ground-truth target Semantic ID">
              SID <code>{tc.target_address.join(' · ')}</code>
            </span>
            <span className={`bucket-badge ${tc.target_group_size > 1 ? 'collided' : 'injective'}`}>
              {tc.target_group_size === 1 ? '1 item · injective' : `${tc.target_group_size.toLocaleString()} items in bucket`}
            </span>
            {tc.target_group_size > 1 ? (
              <span className="within-bucket-ranks">
                Bucket rank: <b>Pop #{tc.target_popularity_rank}</b> · <b>Cos #{tc.target_cosine_rank}</b>
              </span>
            ) : null}
          </div>
        ) : null}
        <small>Evaluation/highlighting only; never used to score members.</small>
      </div>
    </section>
  );
}

function MetricPair({hit, ndcg, cutoff, testId}) {
  return (
    <div className="metric-pair">
      <div>
        <span>Item Hit@{cutoff}</span>
        <strong data-testid={`${testId}-hit`}>{metric(hit)}</strong>
      </div>
      <div>
        <span>NDCG@{cutoff}</span>
        <strong data-testid={`${testId}-ndcg`}>{metric(ndcg)}</strong>
      </div>
    </div>
  );
}

function Ranking({indices, slots, result, overlap, targetRank}) {
  const [expanded, setExpanded] = useState(false);
  const rows = slots
    ? slots.slice(0, result.cutoff).map(slot => ({index: slot.selected_item_index, rank: slot.rank}))
    : indices.slice(0, result.cutoff).map((index, i) => ({index, rank: i + 1}));
  return (
    <div className="ranking">
      <div className="ranking-heading">
        <span className="ranking-label">{expanded ? `Top-${result.cutoff} recommendations` : 'Top-1 recommendation'}</span>
        <button className="text-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Collapse ranking' : `View top ${result.cutoff}`}
          <ChevronDown size={13}/>
        </button>
      </div>
      <ol>
        {rows.slice(0, expanded ? result.cutoff : 1).map(row => (
          <li className={row.index === result.target_item_index ? 'target-item' : ''} key={row.rank}>
            {expanded ? <span className="rank-number">{row.rank}</span> : null}
            <div>
              <strong title={row.index === null ? 'Empty native slot' : itemName(result.items, row.index)}>
                {row.index === null ? 'Empty native slot' : itemName(result.items, row.index)}
              </strong>
              <small>
                {row.index !== null ? result.items[String(row.index)]?.item_id : 'Invalid or repeated address'}
                {row.index === result.target_item_index ? <span className="target-label">Held-out target</span> : null}
              </small>
            </div>
          </li>
        ))}
      </ol>
      <div className="outcome-foot" title="An absent target rank means it is outside the saved output.">
        {overlap === undefined
          ? `Explicit item-ID · full 12,068-item catalog · Target rank ${targetRank ?? '—'}`
          : `Target rank ${targetRank ?? '—'} · ${overlap}/${result.cutoff} items shared with SASRec`}
      </div>
    </div>
  );
}

export function Outcomes({result, policy, setPolicy}) {
  const reference = result.policies.popularity.metrics;
  const activeOutcome = result.policies[policy];
  return (
    <section className="panel outcomes-panel" aria-label="Resolver and sequential model comparison">
      <div className="outcomes-grid">
        {Object.entries(policyLabels).map(([id, label]) => {
          const outcome = result.policies[id];
          const isHit = outcome.metrics.item.hit > 0;
          return (
            <article className={`outcome ${policy === id ? 'active' : ''}`} key={id}>
              <div className="outcome-header">
                <h2>
                  <button onClick={() => setPolicy(id)} aria-pressed={policy === id}>
                    {label}
                    {policy === id ? <Check size={17}/> : null}
                  </button>
                </h2>
                <span className={`status-pill ${isHit ? 'hit' : 'miss'}`}>
                  {isHit ? `HIT @ #${outcome.target_item_rank}` : `MISS @ ${result.cutoff}`}
                </span>
              </div>
              <MetricPair {...outcome.metrics.item} cutoff={result.cutoff} testId={id}/>
              <Ranking slots={outcome.slots} result={result} overlap={outcome.sasrec_overlap_count} targetRank={outcome.target_item_rank}/>
            </article>
          );
        })}
        <article className="outcome baseline">
          <div className="outcome-header">
            <h2>SASRec</h2>
            <span className={`status-pill ${result.sasrec.metrics.hit > 0 ? 'hit' : 'miss'}`}>
              {result.sasrec.metrics.hit > 0 ? `HIT @ #${result.sasrec.target_item_rank}` : `MISS @ ${result.cutoff}`}
            </span>
          </div>
          <MetricPair {...result.sasrec.metrics} cutoff={result.cutoff} testId="sasrec"/>
          <Ranking indices={result.sasrec.ranked_item_indices} result={result} targetRank={result.sasrec.target_item_rank}/>
        </article>
      </div>
      <div className="reference-strip">
        <span>
          SID NDCG@{result.cutoff}
          <strong data-testid="sid-ndcg">{metric(reference.sid.ndcg)}</strong>
          <em className="ref-sub">{activeOutcome.target_sid_rank ? `Target SID @ #${activeOutcome.target_sid_rank}` : 'Target SID absent'}</em>
        </span>
        <span>
          CCE reference
          <strong data-testid="cce-ndcg">{metric(reference.cce.ndcg)}</strong>
          <em className="ref-sub">{activeOutcome.target_group_size.toLocaleString()}-item target bucket</em>
        </span>
        <span className="disagreement-summary">
          Resolver diff: <b>{result.resolver_disagreement_ranks.length}/{result.cutoff}</b> top-{result.cutoff} slots differ
        </span>
        <small>CCE is an expanded-group expectation, not an item resolver.</small>
      </div>
    </section>
  );
}

export function TraceTable({result, policy, rank, setRank}) {
  const rows = result.policies[policy].slots;
  const otherPolicy = policy === 'popularity' ? 'history_cosine' : 'popularity';
  const otherRows = result.policies[otherPolicy].slots;
  const diagnostics = result.policies[policy].diagnostics;
  return (
    <section className="panel trace-panel" aria-label="Native prediction trace">
      <div className="panel-heading">
        <div className="panel-heading-top">
          <h2>Native prediction trace</h2>
          <span className="active-policy-badge">Active: {policyLabels[policy]}</span>
        </div>
        <p>Evaluation rank and original raw slot are preserved. Click any row to inspect its catalog collision group.</p>
      </div>
      <div className="table-scroll trace-scroll">
        <table>
          <thead>
            <tr>
              <th>Rank</th>
              <th>Raw</th>
              <th>Complete SID</th>
              <th>Members</th>
              <th>Selected item</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((slot, idx) => {
              const differs = otherRows[idx] && slot.selected_item_index !== otherRows[idx].selected_item_index;
              return (
                <tr
                  key={slot.rank}
                  onClick={() => setRank(slot.rank)}
                  className={`trace-row ${rank === slot.rank ? 'selected-row' : ''} ${slot.rank > result.cutoff ? 'beyond-cutoff' : ''}`}
                >
                  <td>{slot.rank}</td>
                  <td>{slot.raw_rank}</td>
                  <td>
                    <button
                      className="address-button"
                      aria-label={`Inspect prediction rank ${slot.rank}`}
                      aria-pressed={rank === slot.rank}
                      onClick={e => {
                        e.stopPropagation();
                        setRank(slot.rank);
                      }}
                    >
                      <code className="sid-pill-code">{slot.address.join(' · ')}</code>
                    </button>
                    <div className="slot-badges">
                      {slot.target_address ? <small className="slot-note target-note">Target address</small> : null}
                      {differs && slot.valid && !slot.duplicate ? <small className="slot-note diff-note">Pop ≠ Cos</small> : null}
                      {!slot.valid ? <small className="slot-note">Invalid</small> : null}
                      {slot.duplicate ? <small className="slot-note">Repeated · empty slot</small> : null}
                    </div>
                  </td>
                  <td>
                    <span className={`bucket-count ${slot.group_size > 1 ? 'multi' : 'single'}`}>
                      {slot.group_size.toLocaleString()}
                    </span>
                  </td>
                  <td>
                    <span
                      className={slot.selected_item_index === result.target_item_index ? 'target-item' : ''}
                      title={slot.selected_item_index === null ? '' : itemName(result.items, slot.selected_item_index)}
                    >
                      {slot.selected_item_index === null ? 'Empty slot' : itemName(result.items, slot.selected_item_index)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="table-caption">
        {rows.length} native slots · {diagnostics.distinct_valid_addresses} distinct valid addresses · {diagnostics.invalid_slots} invalid · {diagnostics.repeated_slots} repeated. Shaded ranks beyond {result.cutoff} do not contribute to Hit@{result.cutoff}.
      </div>
    </section>
  );
}

export function GroupInspector({result, policy, setPolicy, slot}) {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState(null);
  const [error, setError] = useState('');
  const address = slot?.address.join(',');
  useEffect(() => {
    if (!address) return;
    const controller = new AbortController();
    const params = {query: result.query_index, model: result.model_id, address, resolver: policy, offset, limit: 20};
    if (search.trim()) params.search = search.trim();
    getJson(endpoint('group', params), {signal: controller.signal})
      .then(setGroup)
      .catch(e => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => controller.abort();
  }, [result.query_index, result.model_id, address, policy, offset, search]);

  const totalCount = group ? (search.trim() ? group.filtered_total : group.total) : 0;
  const targetRank = group?.target_member_rank;
  const targetPageOffset = targetRank ? Math.floor((targetRank - 1) / 20) * 20 : 0;

  return (
    <section className="panel group-panel" aria-label="Collision group">
      <div className="panel-heading">
        <div className="panel-heading-top">
          <h2>Collision group</h2>
          {targetRank ? (
            <div className="target-locator">
              <span className="locator-text">
                <Target size={13}/>Target in bucket: <b>Pop #{group.target_popularity_rank}</b> · <b>Cos #{group.target_cosine_rank}</b>
              </span>
              {offset !== targetPageOffset || search ? (
                <button
                  type="button"
                  className="button small locator-btn"
                  data-testid="jump-to-target"
                  onClick={() => {
                    setSearch('');
                    setOffset(targetPageOffset);
                  }}
                >
                  Jump to target (#{targetRank})
                </button>
              ) : offset > 0 ? (
                <button type="button" className="button small" onClick={() => setOffset(0)}>
                  Back to #1
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <p>
          Selected SID <code>{slot?.address.join(' · ')}</code>
          <span className="divider">|</span>
          {slot?.group_size.toLocaleString()} members
        </p>
        <div className="inspector-controls">
          <label className="resolver-control">
            Resolver
            <select aria-label="Group resolver" value={policy} onChange={e => setPolicy(e.target.value)}>
              {Object.entries(policyLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <div className="member-search-wrap">
            <Search size={13} className="search-icon"/>
            <input
              type="search"
              className="member-search"
              aria-label="Filter collision group"
              placeholder={`Search ${slot?.group_size.toLocaleString() || ''} members…`}
              value={search}
              onChange={e => {
                setSearch(e.target.value);
                setOffset(0);
              }}
            />
          </div>
        </div>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {!group ? (
        <p className="loading">Loading members…</p>
      ) : (
        <>
          <div className="table-scroll group-scroll">
            <table>
              <thead>
                <tr>
                  <th className="rank-col">#</th>
                  <th>Item</th>
                  <th className={`numeric ${policy === 'popularity' ? 'active-col' : ''}`}>Train pop.</th>
                  <th className={`numeric ${policy === 'history_cosine' ? 'active-col' : ''}`}>Cosine score</th>
                </tr>
              </thead>
              <tbody>
                {group.members.map((member, idx) => {
                  const popPct = group.max_popularity > 0 ? Math.round((member.popularity_score / group.max_popularity) * 100) : 0;
                  const cosSpan = Math.max(0.05, (group.max_cosine || 1) - (group.min_cosine || 0));
                  const cosPct = Math.max(4, Math.min(100, Math.round(((member.cosine_score - (group.min_cosine || 0)) / cosSpan) * 100)));
                  return (
                    <tr
                      key={member.item_index}
                      className={`${member.selected ? 'selected-row' : ''} ${member.is_target ? 'target-member-row' : ''}`}
                    >
                      <td className="rank-col">#{member.group_rank ?? offset + idx + 1}</td>
                      <td>
                        <div className="member-title">
                          {member.selected ? <Check size={14} aria-label="Selected member"/> : <span className="check-spacer"/>}
                          <div>
                            <strong>{member.title}</strong>
                            <small>
                              <code>{member.item_id}</code>
                              {member.is_target ? <span className="target-label">Target</span> : null}
                              {member.selected_by_popularity ? <span className="winner-tag pop">Pop #1</span> : null}
                              {member.selected_by_cosine ? <span className="winner-tag cos">Cos #1</span> : null}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td className={`numeric ${policy === 'popularity' ? 'active-col' : ''}`}>
                        <div className="score-cell">
                          <span>{member.popularity_score ?? member.resolver_score}</span>
                          <i className="score-bar pop-bar" style={{width: `${popPct}%`}}/>
                        </div>
                      </td>
                      <td className={`numeric ${policy === 'history_cosine' ? 'active-col' : ''}`}>
                        <div className="score-cell">
                          <span>{(member.cosine_score ?? member.resolver_score).toFixed(6)}</span>
                          <i className="score-bar cos-bar" style={{width: `${cosPct}%`}}/>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!totalCount ? <p className="empty">No catalog members match this view.</p> : null}
          <div className="pagination">
            <button
              className="button small"
              disabled={offset === 0 || group.offset !== offset}
              onClick={() => setOffset(Math.max(0, offset - 20))}
              aria-label="Previous member page"
            >
              <ChevronLeft size={14}/>Previous
            </button>
            <span data-testid="member-page">
              {totalCount ? `${group.offset + 1}–${Math.min(group.offset + 20, totalCount)}` : '0'} of {totalCount.toLocaleString()}
            </span>
            <button
              className="button small"
              disabled={offset + 20 >= totalCount || group.offset !== offset}
              onClick={() => setOffset(offset + 20)}
              aria-label="Next member page"
            >
              Next<ChevronRight size={14}/>
            </button>
          </div>
          <p className="table-caption">
            Scores use training data only. Ties select the smallest global item index. Targets are highlighted only for evaluation.
          </p>
        </>
      )}
    </section>
  );
}

export function Contracts({bootstrap, model, result}) {
  return (
    <details className="panel contracts">
      <summary>
        <span>Run contracts and provenance</span>
        <span>SID context {model.context.max_items} items · SASRec context {bootstrap.baseline.context.max_items} items · Resolver features ST5</span>
      </summary>
      <div className="contracts-body">
        <p>
          <strong>{bootstrap.scope.label}.</strong> Twelve neutral samples and six deliberately selected diagnostic cases share exact query/catalog identities. These examples do not establish aggregate model superiority or equal tuning.
        </p>
        <div className="contract-grid">
          <div>
            <h3>{model.label} · OpenAI · seed {model.seed}</h3>
            <p>{model.decoder_budget} native beams. {model.ranking_description}. Maximum history: {model.context.max_items} items; this query uses {result.effective_history_item_indices.length}.</p>
            <p>Checkpoint selection: {model.checkpoint_selection_objective}.</p>
            <p>Shared catalog: {model.catalog_summary.items.toLocaleString()} items. {model.catalog_summary.collision_groups.toLocaleString()} collided groups; {model.catalog_summary.collided_items.toLocaleString()} items in them.</p>
            <details><summary>Model recipe</summary><pre>{JSON.stringify(model.recipe, null, 2)}</pre></details>
          </div>
          <div>
            <h3>Explicit item resolvers</h3>
            <p>Both policies select one member within each predicted complete-address group. Invalid and repeated addresses consume empty slots.</p>
            <p>Popularity: training event counts. History cosine: frozen raw ST5 features and training-only user profiles. Member scores are frozen; policy selection and metrics are reconstructed at request time.</p>
            <p>OpenAI tokenizer features and ST5 resolver features have separate roles. The held-out target never enters member scoring.</p>
          </div>
          <div>
            <h3>SASRec · matched history</h3>
            <p>Scores the full 12,068-item catalog; exports only the top 20. Maximum history: 50 items; this query uses {result.sasrec.effective_history_item_indices.length}. Absence means outside saved top 20, not a known full-catalog rank.</p>
            <details><summary>Baseline recipe</summary><pre>{JSON.stringify(bootstrap.baseline.recipe, null, 2)}</pre></details>
          </div>
        </div>
        <details><summary>Source lineage and hashes</summary><pre>{JSON.stringify(bootstrap.provenance, null, 2)}</pre></details>
      </div>
    </details>
  );
}
