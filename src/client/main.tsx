import './styles.css';
import { App } from './App';

const root = document.querySelector<HTMLElement>('#root');

if (!root) {
  throw new Error('The application root element is missing.');
}

root.replaceChildren(App());
