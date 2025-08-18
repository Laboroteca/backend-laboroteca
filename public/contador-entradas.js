(function(){
  function init(root){
    var formId = root.getAttribute('data-form') || '';
    var api    = root.getAttribute('data-api') || '';
    var fecha  = root.getAttribute('data-fecha') || '';
    var max    = root.getAttribute('data-max') || '';
    var desc   = root.getAttribute('data-desc') || '';
    var hide   = (root.getAttribute('data-hide') || '1') === '1';

    var form = formId ? document.querySelector('#fluentform_' + formId) : null;
    if (form){
      if(!fecha){ var f=form.querySelector('input[name="fechaActuacion"]'); if(f&&f.value) fecha=f.value; }
      if(!(parseInt(max,10)>0)){ var m=form.querySelector('input[name="maximoEntradas"]'); if(m&&m.value) max=m.value; }
      if(!desc){ var d=form.querySelector('input[name="descripcionProducto"]'); if(d&&d.value) desc=d.value; }
    }

    var estadoEl = root.querySelector('.estado') || root;
    if(!desc || !fecha || !(parseInt(max,10)>0)){
      estadoEl.textContent='Configuración incompleta.'; return;
    }

    var url = new URL(api);
    url.searchParams.set('desc', desc);
    url.searchParams.set('fecha', fecha);
    url.searchParams.set('max', parseInt(max,10));

    fetch(url.toString(), { method:'GET', credentials:'omit' })
      .then(function(r){ return r.json(); })
      .then(function(data){
        if(!data || data.error){ estadoEl.textContent='No disponible.'; return; }
        if(!data.abierta){
          var msg = (data.motivo === 'agotadas') ? 'ENTRADAS AGOTADAS' : 'EVENTO CERRADO';
          estadoEl.textContent = msg;
          estadoEl.classList.add('cerrado');
          if(hide && form){
            form.querySelectorAll('button[type="submit"],input[type="submit"]').forEach(function(btn){
              btn.disabled = true; btn.style.pointerEvents='none'; btn.style.opacity='0.6'; btn.textContent = msg;
            });
          }
        } else {
          estadoEl.textContent = 'Quedan ' + data.restantes + ' de ' + data.maximo;
        }
      })
      .catch(function(){ estadoEl.textContent='No disponible.'; });
  }

  document.addEventListener('DOMContentLoaded', function(){
    document.querySelectorAll('.contador-entradas[data-api]').forEach(init);
  });
})();
