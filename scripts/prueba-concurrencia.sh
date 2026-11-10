#!/usr/bin/env bash
# Prueba de concurrencia REAL contra el Supabase local (varias sesiones de Postgres a la vez).
# pgTAP corre en una sola sesión y no puede simular carreras; aquí se lanzan N sesiones en paralelo.
# Uso:  bash scripts/prueba-concurrencia.sh     (requiere `supabase start`; deja filas de prueba: `supabase db reset` las limpia)
set -euo pipefail

C=$(docker ps --format '{{.Names}}' | grep '^supabase_db_naidi-pos' | head -1)
[ -n "$C" ] || { echo "No encuentro el contenedor de la base local. ¿Corriste 'supabase start'?"; exit 1; }
PSQL="docker exec -i $C psql -U postgres -v ON_ERROR_STOP=1 -tA"
N=8
fallos=0

sql()   { $PSQL -c "$1"; }
como()  { echo "select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated','aal','${2:-aal1}')::text, false);"; }
afirmar() { # descripcion esperado obtenido
  if [ "$2" = "$3" ]; then echo "  OK   $1 (= $3)"; else echo "  FALLA $1: esperado $2, obtenido $3"; fallos=$((fallos+1)); fi
}

U() { printf '00000000-0000-0000-0000-%012x' "$((RANDOM*RANDOM + $1))"; }
CAJ=$(U 1000001); CL1=$(U 2000002); CL2=$(U 3000003)

sql "insert into auth.users (id, aud, role, email) values ('$CAJ','authenticated','authenticated','conc-caj-$CAJ@prueba.test'),('$CL1','authenticated','authenticated','conc-c1-$CL1@prueba.test'),('$CL2','authenticated','authenticated','conc-c2-$CL2@prueba.test');
     insert into public.perfiles (user_id, nombre) values ('$CL1','Conc Uno'),('$CL2','Conc Dos') on conflict (user_id) do update set nombre = excluded.nombre;
     insert into public.staff (user_id, rol, nombre) values ('$CAJ','cajero','Conc Cajero');" >/dev/null

echo "1) $N sesiones reclaman el MISMO QR posterior a la vez"
VENTA=$($PSQL <<EOF | tail -1
$(como "$CAJ") select public.crear_venta(gen_random_uuid());
EOF
)
TOKEN=$($PSQL <<EOF | tail -1
$(como "$CAJ")
select public.agregar_linea('$VENTA','americano') is not null;
select public.confirmar_venta('$VENTA') is not null;
select public.pagar_venta('$VENTA','efectivo',5000) ->> 'qr_token';
EOF
)
dir=$(mktemp -d)
for i in $(seq 1 $N); do
  ( $PSQL -c "$(como "$CL1")" -c "select public.reclamar_qr_posventa('$TOKEN')" >/dev/null 2>&1 && echo ok > "$dir/qr$i" || echo no > "$dir/qr$i" ) &
done
wait
afirmar "reclamos exitosos" 1 "$(cat $dir/qr* | grep -c ok)"
afirmar "sumas en el libro para la venta" 1 "$(sql "select count(*) from public.puntos_libro where venta_id='$VENTA' and tipo='suma'")"

echo "2) $N sesiones pagan la MISMA venta a la vez"
V2=$($PSQL <<EOF | tail -1
$(como "$CAJ") select public.crear_venta(gen_random_uuid(), '$CL2');
EOF
)
$PSQL >/dev/null <<EOF
$(como "$CAJ")
select public.agregar_linea('$V2','bowl-personalizado','grande',null,'mango') is not null;
select public.confirmar_venta('$V2') is not null;
EOF
for i in $(seq 1 $N); do
  ( $PSQL -c "$(como "$CAJ")" -c "select public.pagar_venta('$V2','datafono_bold')" >/dev/null 2>&1 && echo ok > "$dir/pg$i" || echo no > "$dir/pg$i" ) &
done
wait
afirmar "cobros exitosos" 1 "$(cat $dir/pg* | grep -c ok)"
afirmar "sumas en el libro para la venta" 1 "$(sql "select count(*) from public.puntos_libro where venta_id='$V2' and tipo='suma'")"

echo "3) $N sesiones canjean el MISMO saldo (130 puntos, premio de 130) a la vez"
sql "insert into public.puntos_libro (cliente_id, tipo, puntos, nota) values ('$CL1','bono',130,'concurrencia')" >/dev/null
SALDO0=$(sql "select coalesce(sum(puntos),0) from public.puntos_libro where cliente_id='$CL1'")
for i in $(seq 1 $N); do
  ( $PSQL -c "$(como "$CL1")" -c "select public.canjear_premio('mediano')" >/dev/null 2>&1 && echo ok > "$dir/cj$i" || echo no > "$dir/cj$i" ) &
done
wait
afirmar "canjes exitosos" 1 "$(cat $dir/cj* | grep -c ok)"
afirmar "vouchers de premio creados" 1 "$(sql "select count(*) from public.vouchers where cliente_id='$CL1' and tipo='premio'")"
afirmar "saldo final (nunca negativo por doble gasto)" "$((SALDO0 - 130))" "$(sql "select coalesce(sum(puntos),0) from public.puntos_libro where cliente_id='$CL1'")"

echo "4) PIN del dueño: los intentos fallidos de sesiones SEPARADAS se conservan y el límite se aplica"
DUE=$(U 4000004)
sql "insert into auth.users (id, aud, role, email) values ('$DUE','authenticated','authenticated','conc-due-$DUE@prueba.test');
     insert into public.staff (user_id, rol, nombre) values ('$DUE','dueno','Conc Dueño');
     insert into private.staff_pin (user_id, pin_hash) values ('$DUE', extensions.crypt('2468', extensions.gen_salt('bf', 4)));" >/dev/null
for i in 1 2 3; do
  $PSQL -c "$(como "$DUE" aal2)" -c "select public.cambiar_bandera('referidos', true, null, null, '0000')" >/dev/null
done
afirmar "intentos guardados tras 3 fallos en 3 sesiones" 3 "$(sql "select intentos from private.staff_pin where user_id='$DUE'")"
for i in $(seq 1 6); do
  ( $PSQL -c "$(como "$DUE" aal2)" -c "select public.cambiar_bandera('referidos', true, null, null, '0000')" >/dev/null 2>&1 ) &
done
wait
afirmar "bloqueado tras agotar los intentos en paralelo" t "$(sql "select (bloqueado_hasta is not null and bloqueado_hasta > now()) from private.staff_pin where user_id='$DUE'")"
RES=$($PSQL -c "$(como "$DUE" aal2)" -c "select public.cambiar_bandera('referidos', true, null, null, '2468') ->> 'error'" | tail -1)
afirmar "con el PIN correcto, bloqueado, no se puede actuar" pin_bloqueado "$RES"
afirmar "la bandera no cambió" f "$(sql "select activa from public.banderas where clave='referidos'")"

rm -rf "$dir"
echo
if [ "$fallos" -eq 0 ]; then echo "Concurrencia: todo bien."; else echo "Concurrencia: $fallos fallas."; exit 1; fi
