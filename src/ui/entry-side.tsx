import '@fontsource/jost/latin-400.css';

import '@fontsource/jost/latin-600.css';
import './styles.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SidePanel } from './SidePanel';
createRoot(document.getElementById('root')!).render(<SidePanel />);
