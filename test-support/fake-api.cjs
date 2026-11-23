'use strict';
// Preload exclusivo de pruebas: ninguna petición llega a la red.
globalThis.fetch=async(url,opts)=>{
  const telegram=url.startsWith('https://api.telegram.org/');
  const method=telegram?url.split('/').at(-1):opts.body.get('wsfunction');
  if(method==='getUpdates') {
    console.log('TEST_POLL_READY');
    return new Promise((resolve,reject)=>{
      if(opts.signal.aborted)return reject(opts.signal.reason);
      opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true});
    });
  }
  const data=telegram?{ok:true,result:method==='getWebhookInfo'?{url:''}:[]}:{
    core_webservice_get_site_info:{userid:1,fullname:'Synthetic Student'},
    core_calendar_get_action_events_by_timesort:{events:[]},
    core_calendar_get_calendar_upcoming_view:{events:[]},core_enrol_get_users_courses:[],
    message_popup_get_popup_notifications:{notifications:[]},
  }[method];
  if(data===undefined)throw new Error('Unexpected fake API method');
  return {ok:true,json:async()=>data};
};
