self.addEventListener('install',event=>{self.skipWaiting()});
self.addEventListener('activate',event=>{event.waitUntil(self.clients.claim())});
self.addEventListener('push',event=>{
 let data={title:'GoalMatrix · AI Alert',body:'Νέα live ένδειξη'};
 try{if(event.data)data={...data,...event.data.json()}}catch{try{if(event.data)data.body=event.data.text()}catch{}}
 const reportPushResult=async(stage,error)=>{
  try{
   await fetch('https://goalmatrix-live.onrender.com/api/push/ack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    stage,
    tag:String(data.tag||'').slice(0,120),
    error:stage==='show_failed'?String(error&&error.message||error||'showNotification failed').slice(0,140):undefined
   })});
  }catch{}
 };
 event.waitUntil((async()=>{
  try{
   await self.registration.showNotification(data.title||'GoalMatrix · AI Alert',{
    body:data.body||'Νέα live ένδειξη',
    icon:'/goal-pulse/goalmatrix-icon.svg',
    badge:'/goal-pulse/goalmatrix-icon.svg',
    tag:data.tag||'goal-pulse-push',
    data:{url:data.url||'/goal-pulse/'},
    requireInteraction:false
   });
   await reportPushResult('shown');
   try{
    const openClients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of openClients)client.postMessage({type:'GOAL_PULSE_ALERT_PUSH',tag:String(data.tag||'').slice(0,120)});
   }catch{}
  }catch(error){
   await reportPushResult('show_failed',error);
   throw error;
  }
 })());
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 const target=event.notification.data&&event.notification.data.url||'/';
 event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
  for(const client of list){if('focus' in client){client.navigate(target);return client.focus()}}
  return clients.openWindow?clients.openWindow(target):undefined;
 }));
});