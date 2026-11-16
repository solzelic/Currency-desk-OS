import { expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { createDb } from '../src/db/index.js';
import { createIdDoor } from '../src/onboarding/cd-id-door.js';
import { registerSignupDeskRoutes } from '../src/routes/signup-desk.js';
import { signupPack } from '../src/onboarding/signup-pack.js';
it('public illustrative pack is fixed configuration and never looks up a reservation',async()=>{
 process.env.PGLITE_MEMORY='1';const handle=await createDb(),app=Fastify();await app.register(cookie);
 const door=createIdDoor({db:handle.db,logRefusal:()=>{throw Error('must not use reservation door');}});
 door.findByCdId=async()=>{throw Error('must not look up identity');};
 registerSignupDeskRoutes(app,handle.db,door);
 try{
  const response=await app.inject({url:'/api/signup/tour-pack'});expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({example:true,pack:signupPack('CA')});
  expect(signupPack('XX')).toMatchObject({exampleForeignCurrency:null,reportName:null,idLine:{legal:null,recommended:null},law:[]});
 }finally{await app.close();await handle.close();}
});
