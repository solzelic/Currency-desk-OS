/* Compile the frozen signup template at build time. The browser receives
   ordinary React calls, with no HTML parser, dynamic evaluation or second
   fetch of its own page. Unknown template constructs fail the build. */
import { parseFragment, serialize } from 'parse5';
const quote = JSON.stringify;
const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const names = { class: 'className', for: 'htmlFor', tabindex: 'tabIndex', inputmode: 'inputMode', autocomplete: 'autoComplete', autocapitalize: 'autoCapitalize', maxlength: 'maxLength', spellcheck: 'spellCheck', autoplay: 'autoPlay', playsinline: 'playsInline', viewbox: 'viewBox', preserveaspectratio: 'preserveAspectRatio' };
const events = { onclick: 'onClick', onchange: 'onChange', oninput: 'onInput', onfocus: 'onFocus', onblur: 'onBlur', onkeydown: 'onKeyDown', onmousedown: 'onMouseDown', onscroll: 'onScroll' };
const tags = new Set('a b button circle div h1 h2 i iframe img input label p path rect span strong svg video'.split(' '));
const boolean = new Set(['disabled', 'muted', 'loop', 'autoplay', 'playsinline', 'inert']);
function expression(raw) {
  const s = raw.trim();
  if (['true', 'false', 'null'].includes(s)) return s;
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(s)) throw new Error('Unsupported signup expression: ' + s);
  return 'v' + s.split('.').map(p => '?.[' + quote(p) + ']').join('');
}
function attr(raw) {
  const whole = raw.match(/^\s*\{\{([\s\S]+?)\}\}\s*$/);
  if (whole) return expression(whole[1]);
  const parts = raw.split(/\{\{([\s\S]+?)\}\}/g);
  return parts.map((s,i) => i % 2 ? '(' + expression(s) + ' ?? "")' : quote(s)).join(' + ');
}
export function compileSignup(html) {
  const template = html.match(/<x-dc>([\s\S]*?)<\/x-dc>/g);
  const scripts = [...html.matchAll(/<script\b[^>]*data-dc-script[^>]*>([\s\S]*?)<\/script>/g)];
  if (template?.length !== 1 || scripts.length !== 1) throw new Error('Signup requires exactly one template and logic class');
  const tree = parseFragment(template[0].slice(6, -7));
  const head = [], css = [], functions = [];
  let next = 0;
  function node(n) {
    const id = next++, fn = 's' + id;
    let code;
    if (n.nodeName === '#comment') return null;
    if (n.nodeName === '#text') {
      const text = n.value;
      if (!text.trim() && !text.includes(' ')) return null;
      const parts = text.split(/\{\{([\s\S]+?)\}\}/g);
      code = parts.length === 1 ? quote(text) : 'h(React.Fragment,{key:k},' + parts.map((p,i) => i % 2 ? 'text(' + expression(p) + ',' + i + ')' : quote(p)).join(',') + ')';
    } else if (n.tagName === 'helmet') {
      head.push(serialize(n)); return null;
    } else {
      const a = Object.fromEntries((n.attrs || []).map(a => [a.name, a.value]));
      const children = (n.childNodes || []).map(node).filter(Boolean);
      const kids = children.map((f,i) => f + '(v,' + i + ')').join(',');
      if (n.tagName === 'sc-if') code = '(' + attr(a.value || '') + ' ? h(React.Fragment,{key:k},' + (kids || 'null') + ') : null)';
      else if (n.tagName === 'sc-for') {
        if (!/^[A-Za-z_$][\w$]*$/.test(a.as || 'item')) throw new Error('Invalid signup loop binding');
        code = 'h(React.Fragment,{key:k},(' + attr(a.list || '') + ' || []).map((item,i)=>{const v={...outer,' + quote(a.as || 'item') + ':item,$index:i};return h(React.Fragment,{key:i},' + (kids || 'null') + ')}))';
      } else {
        if (!tags.has(n.tagName)) throw new Error('Unsupported signup tag: ' + n.tagName);
        const props = ['key:k'], classes = [];
        for (const [name,value] of Object.entries(a)) {
          if (name.startsWith('hint-')) continue;
          if (name.startsWith('style-')) {
            const state = name.slice(6);
            if (!['hover','focus','active'].includes(state) || value.includes('{{')) throw new Error('Unsupported signup pseudo style');
            const cls = 'signup-p' + css.length;
            css.push('.' + cls + ':not(:disabled):' + state + '{' + value.replace(/;?\s*$/, ';').replace(/;/g, ' !important;') + '}'); classes.push(cls); continue;
          }
          let key = events[name] || names[name] || (name.startsWith('stroke-') ? camel(name) : name);
          if (name.startsWith('on') && !events[name]) throw new Error('Unsupported signup event: ' + name);
          let valueCode = attr(value);
          if (boolean.has(name) && !value.includes('{{')) valueCode = value !== 'false' ? 'true' : 'false';
          if (name === 'style') valueCode = 'style(' + valueCode + ')';
          if (name === 'value') valueCode = '(' + valueCode + ' ?? "")';
          props.push(quote(key) + ':' + valueCode);
        }
        if (classes.length) props.push('className:' + quote(classes.join(' ')));
        code = 'h(' + quote(n.tagName) + ',{' + props.join(',') + '}' + (kids ? ',' + kids : '') + ')';
      }
    }
    functions.push('function ' + fn + '(v,k){' + (n.tagName === 'sc-for' ? 'const outer=v;' : '') + 'return ' + code + ';}');
    return fn;
  }
  const roots = tree.childNodes.map(node).filter(Boolean);
  const runtime = `const h=React.createElement;
function text(v,k){return v==null||typeof v==='boolean'?null:React.isValidElement(v)||Array.isArray(v)?h(React.Fragment,{key:k},v):h('span',{key:k,className:'sc-interp'},String(v));}
function style(s){if(typeof s!=='string')return s;const o={};for(const part of s.split(';')){const i=part.indexOf(':');if(i<0)continue;const k=part.slice(0,i).trim();o[k.startsWith('--')?k:k.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=part.slice(i+1).trim();}return o;}
class DCLogic{constructor(props){this.props=props||{};this.state={};}setState(p,cb){const prev=this.state;this.state={...prev,...(typeof p==='function'?p(prev):p)};this.__previous=prev;this.__host?.setState(s=>({revision:s.revision+1}),cb);}forceUpdate(){this.__host?.forceUpdate();}}
`;
  const boot = `class Signup extends React.Component{constructor(p){super(p);this.state={revision:0};this.logic=new Component(p);this.logic.__host=this;}componentDidMount(){this.logic.componentDidMount?.();}componentDidUpdate(p){this.logic.componentDidUpdate?.(p,this.logic.__previous||this.logic.state);}componentWillUnmount(){this.logic.componentWillUnmount?.();}render(){const v={...this.props,...this.logic.renderVals()};return h('div',{className:'sc-host'},${roots.map((f,i)=>f+'(v,'+i+')').join(',')});}}
ReactDOM.createRoot(document.getElementById('dc-root')).render(h(Signup,{startStep:0,prefillDemo:false}));`;
  const js = '/* Generated by build-signup; edit design/onboarding and scripts/signup-aot.mjs. */\n(function(){"use strict";\n' + runtime + scripts[0][1] + '\n' + functions.join('\n') + '\n' + boot + '\n})();\n';
  const output = html.replace(template[0], '<div id="dc-root"></div>').replace(scripts[0][0], '<script defer src="/web/app/signup.js"></script>')
    .replace(/<script>window\.__resources = [\s\S]*?<\/script>/, '')
    .replace('<script src="/web/support.js"></script>', '<script defer src="/web/vendor/react.production.min.js"></script>\n<script defer src="/web/vendor/react-dom.production.min.js"></script>')
    .replace('</head>', head.join('\n') + '\n<style>html,body{height:100%;margin:0}#dc-root,#dc-root>.sc-host{height:100%}' + css.join('\n') + '</style>\n</head>');
  return { html: output, js };
}
