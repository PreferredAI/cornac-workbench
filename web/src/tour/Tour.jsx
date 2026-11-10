import React, {useEffect, useRef} from 'react';
import {ArrowLeft, ArrowRight} from 'lucide-react';
import Scene1 from './Scene1.jsx';
import Scene2 from './Scene2.jsx';
import Scene3 from './Scene3.jsx';
import Scene4 from './Scene4.jsx';
import Scene5 from './Scene5.jsx';
import './tour.css';

export const steps = ['Shopper', 'Two recommenders', 'SID to item', 'Next items', 'Made with Cornac'];
const scenes = [Scene1, Scene2, Scene3, Scene4, Scene5];

export default function Tour({scene, onScene, ...props}) {
  const frame = useRef(null);
  const Scene = scenes[scene - 1];

  useEffect(() => {
    scrollTo(0, 0);
    const heading = frame.current?.querySelector('.tour-scene h1');
    if (heading) {heading.tabIndex = -1; heading.focus({preventScroll: true});}
  }, [scene]);

  useEffect(() => {
    function onKey(event) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.target.closest?.('input, select, textarea, [contenteditable="true"], [role="radiogroup"], [role="tablist"], dialog')) return;
      if (event.key === 'ArrowRight' && scene < steps.length) onScene(scene + 1);
      else if (event.key === 'ArrowLeft' && scene > 1) onScene(scene - 1);
    }
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [scene, onScene]);

  return <div className="tour" ref={frame} data-scene={scene}>
    <nav className="tour-bar" aria-label="Tour">
      <div className="tour-bar-side"><button className="button" disabled={scene === 1} onClick={() => onScene(scene - 1)}><ArrowLeft size={16} aria-hidden="true"/>Back</button></div>
      <ol className="tour-steps">{steps.map((label, i) =>
        <li key={label} className={i < scene ? 'is-reached' : undefined}>
          <button aria-current={i + 1 === scene ? 'step' : undefined} onClick={() => onScene(i + 1)}><i aria-hidden="true"/><span>{label}</span></button>
        </li>)}</ol>
      <div className="tour-bar-side is-end">{scene < steps.length ? <>
        <button className="button primary" onClick={() => onScene(scene + 1)}>Next<ArrowRight size={16} aria-hidden="true"/></button>
        <button className="text-button tour-skip" onClick={props.onExplore}>Skip tour</button>
      </> : null}</div>
    </nav>
    <section className="tour-scene" key={scene} aria-label={steps[scene - 1]}>
      <p className="tour-eyebrow">Step {scene} of {steps.length}</p>
      <Scene {...props}/>
    </section>
  </div>;
}
