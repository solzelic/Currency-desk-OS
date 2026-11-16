import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { compileSignup } from '../scripts/signup-aot.mjs';
const shell = body => `<html><head><script src="/web/support.js"></script></head><body><x-dc>${body}</x-dc><script data-dc-script>class Component extends DCLogic {renderVals(){return {label:'Synthetic', enabled:true, rows:[{name:'First'},{name:'Second'}], click:()=>{}};}}</script></body></html>`;
test('compiles conditions, loops, native controls and escaped text without browser evaluation', () => {
  const built = compileSignup(shell('<sc-if value="{{ enabled }}"><button onClick="{{ click }}" disabled="{{ false }}" style="color: red;">{{ label }}</button><sc-for list="{{ rows }}" as="row"><span>{{ row.name }}</span></sc-for></sc-if>'));
  let mount;
  const React = { createElement: (type, props, ...children) => ({ type, props, children }), isValidElement: v => !!v?.type, Fragment: 'fragment', Component: class { constructor(p){this.props=p;} } };
  vm.runInNewContext(built.js, { React, ReactDOM:{createRoot:()=>({render:v=>{mount=v;}})}, document:{getElementById:()=>({})} });
  const rendered = new mount.type(mount.props).render();
  const serialized = JSON.stringify(rendered);
  assert.match(serialized, /Synthetic/); assert.match(serialized, /First/); assert.match(serialized, /Second/);
  assert.match(serialized, /"disabled":false/); assert.match(serialized, /"color":"red"/);
  assert.doesNotMatch(built.html, /support\.js|text\/x-dc|<x-dc>/);
  assert.doesNotMatch(built.js, /new Function|eval\(|DOMParser/);
});
test('unknown template behavior and executable expressions fail the build', () => {
  assert.throws(() => compileSignup(shell('<sc-unknown/>')), /Unsupported signup tag/);
  assert.throws(() => compileSignup(shell('<span>{{ window.location.assign("evil") }}</span>')), /Unsupported signup expression/);
  assert.throws(() => compileSignup(shell('<button onUnknown="{{ click }}"/>')), /Unsupported signup event/);
});
test('styles move into the head; focus and active styles remain available', () => {
  const built = compileSignup(shell('<helmet><style>.hello{color:red}</style></helmet><input style-focus="color: green;" style-active="opacity: .5;"/>'));
  assert.match(built.html, /<style>\.hello\{color:red\}<\/style>/);
  assert.match(built.html, /:focus\{color: green !important;/);
  assert.match(built.html, /:active\{opacity: .5 !important;/);
});

test('lifecycle reports the last committed state across batches and forced renders', () => {
 const built=compileSignup(shell('<span/>'));
 let mount;
 const React={createElement:(type,props)=>({type,props}),Component:class{constructor(p){this.props=p;} setState(){} forceUpdate(){}}};
 vm.runInNewContext(built.js,{React,ReactDOM:{createRoot:()=>({render:v=>{mount=v;}})},document:{getElementById:()=>({})}});
 const host=new mount.type(mount.props), c=host.logic, seen=[];
 c.state={i:0};c.componentDidUpdate=(_p,previous)=>seen.push(previous.i);host.componentDidMount();
 c.setState({i:1});c.setState({i:2});host.componentDidUpdate({});
 c.forceUpdate();host.componentDidUpdate({});
 c.setState({label:'changed'});host.componentDidUpdate({});
 assert.deepEqual(seen,[0,2,2]);
});
