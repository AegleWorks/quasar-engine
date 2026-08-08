import { parseBBCode } from './src/BBCode/Parser';
import { HTMLRenderer } from './src/Visitors/HTMLRenderer';

const ast = parseBBCode('[color=#61afef]Colored text[/color] and [size=150]Large text[/size]');
const html = new HTMLRenderer().render(ast.redRoot!);
console.log(html);
