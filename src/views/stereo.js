import { html, render } from '../ui/dom.js';

export default {
  title: 'Stereo',
  mount(root) { render(root, html`<h1 class="text-2xl font-bold">Stereo</h1><p class="muted">Coming up.</p>`); },
};
