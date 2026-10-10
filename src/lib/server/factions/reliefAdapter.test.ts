import {expect,test} from 'vitest';
import {grainPool,projectInventory,settleProjectInventory} from './reliefAdapter';
import {boundReliefProof} from './projectLifecycle';

test('attributed reservations reduce another project budget without changing physical stock',()=>{
 const resource={id:'grain',amount:100,metadata:{reservedGrain:70,unattributedReservedGrain:10,reliefReservations:{a:40,b:20}}};
 expect(projectInventory(resource,'a')).toMatchObject({id:'grain',amount:70,metadata:{reservedGrain:40}});
 expect(projectInventory(resource,'new')).toMatchObject({amount:30,metadata:{reservedGrain:0}});
 const settled=settleProjectInventory(resource,'a',70,30,0);
 expect(settled).toMatchObject({amount:60,metadata:{reservedGrain:30,reliefReservations:{b:20},unattributedReservedGrain:10}});
});
test.each([
 {amount:100,metadata:{reservedGrain:90,reliefReservations:{a:40},unattributedReservedGrain:0}},
 {amount:20,metadata:{reservedGrain:40,reliefReservations:{a:40}}},
 {amount:100,metadata:{reservedGrain:0,reliefReservations:{a:-1}}},
 {amount:100,metadata:{reservedGrain:1.5}},
])('inconsistent shared pools fail closed: %j',resource=>{expect(()=>grainPool(resource)).toThrow();});
test('a new project cannot spend an unattributed older reservation',()=>{
 const r={amount:100,metadata:{reservedGrain:80}};
 expect(projectInventory(r,'new').amount).toBe(20);
 expect(()=>settleProjectInventory(r,'new',20,-10,0)).toThrow(/exceeds/);
 expect(settleProjectInventory(r,'new',20,20,10).metadata).toMatchObject({reservedGrain:90,unattributedReservedGrain:80});
});
test('an explicit reusable authority binds distinct project identities without changing its source',()=>{
 const grant={scope:'relief_authority',version:2,ownerEntityId:'owner',supplierId:'a',recipientId:'b',locationId:'granary',meansEntityIds:['wagon'],maxGrain:40,mode:'routine',playerConsent:'not_required'};
 expect(boundReliefProof({reliefExecutionGrant:grant},'first')?.projectId).toBe('first');
 expect(boundReliefProof({reliefExecutionGrant:grant},'second')?.projectId).toBe('second');
 expect(grant).not.toHaveProperty('projectId');expect(boundReliefProof({reliefExecutionGrant:{...grant,version:3}},'third')).toBeNull();
});
