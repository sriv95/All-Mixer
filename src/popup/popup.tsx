import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);

// Firefox only: a site-access notice above the popup. A second root keeps the Chrome bundle free of it.
if (__FIREFOX__) {
  void import('./FirefoxAccess').then(({ FirefoxAccess }) => {
    const host = document.createElement('div');
    host.style.marginBottom = '14px';
    document.getElementById('root')!.before(host);
    createRoot(host).render(<FirefoxAccess />);
  });
}
