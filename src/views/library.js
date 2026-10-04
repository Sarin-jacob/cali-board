import { html, render } from '../ui/dom.js';

export default {
  title: 'Library',
  mount(root) { render(root, html`<h1 class="text-2xl font-bold">Library</h1><p class="muted">Coming up.</p>`); },
};
