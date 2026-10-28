import './styles.css';
import { App } from './App';
import { applyClientDesignTokens } from './applyDesignTokens';

applyClientDesignTokens(document.documentElement.style);

const root = document.querySelector<HTMLElement>('#root');

if (!root) {
  throw new Error('The application root element is missing.');
}

root.replaceChildren(App());
