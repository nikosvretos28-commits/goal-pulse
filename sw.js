self.addEventListener('install',event=>{self.skipWaiting()});
self.addEventListener('activate',event=>{event.waitUntil(self.clients.claim())});
self.addEventListener('push',event=>{
 let data={title:'GoalMatrix · AI Alert',body:'Νέα live ένδειξη'};
 try{if(event.data)data={...data,...event.data.json()}}catch{try{if(event.data)data.body=event.data.text()}catch{}}
 event.waitUntil(self.registration.showNotification(data.title||'GoalMatrix · AI Alert',{
  body:data.body||'Νέα live ένδειξη',
  icon:'/goalmatrix-icon.svg',
  badge:'/goalmatrix-icon.svg',
  tag:data.tag||'goal-pulse-push',
  data:{url:data.url||'/'},
  requireInteraction:false
 }));
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 const target=event.notification.data&&event.notification.data.url||'/';
 event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
  for(const client of list){if('focus' in client){client.navigate(target);return client.focus()}}
  return clients.openWindow?clients.openWindow(target):undefined;
 }));
});