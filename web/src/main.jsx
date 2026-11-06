import React from 'react';
import { createRoot } from 'react-dom/client';
import {lazy, Suspense} from 'react';
import Journeys from './Journeys.jsx';
import './styles.css';
const Diagnostics = lazy(() => import('./App.jsx'));
const diagnostics = new URLSearchParams(location.search).get('view') === 'diagnostics';
createRoot(document.getElementById('root')).render(diagnostics
  ? <Suspense fallback={<p role="status">Loading diagnostics…</p>}><Diagnostics/></Suspense>
  : <Journeys/>);
