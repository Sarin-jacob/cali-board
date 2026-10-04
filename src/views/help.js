import { html, render } from '../ui/dom.js';

export default {
  title: 'Guide',
  mount(root) { render(root, html`<h1 class="text-2xl font-bold">Guide</h1><p class="muted">Coming up.</p>`); },
};
