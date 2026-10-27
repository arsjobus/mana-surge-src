export const N = 5;                       // board radius -> 91 hex tiles
export const INNER_RADIUS = 3;             // radius of the green "battlefield" zone; beyond this is grey stone
export const HEX_SIZE = 34;                // on-screen hex radius (center->corner)
export const DIRS = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];

export function key(q,r){ return q+','+r; }
export function neighbors(q,r){ return DIRS.map(d=>({q:q+d[0], r:r+d[1]})); }
export function hexDistance(a,b){
  return (Math.abs(a.q-b.q)+Math.abs(a.q+a.r-b.q-b.r)+Math.abs(a.r-b.r))/2;
}
export function axialToPixel(q,r,size){
  return { x: size*1.5*q, y: size*Math.sqrt(3)*(r+q/2) };
}
export function hexPolygonPoints(cx,cy,r){
  const pts=[];
  for(let i=0;i<6;i++){
    const a = Math.PI/180*(60*i);
    pts.push((cx+r*Math.cos(a)).toFixed(2)+','+(cy+r*Math.sin(a)).toFixed(2));
  }
  return pts.join(' ');
}
// 3-fold rotational symmetry helpers (rotate a hex 120° around the center).
// Used so combat shrines / hazards are mirrored identically for all three
// players -> a provably fair, balanced board every game.
export function cubeFromAxial(a){ return {x:a.q, z:a.r, y:-a.q-a.r}; }
export function axialFromCube(c){ return {q:c.x, r:c.z}; }
export function rotate60Cube(c){ return {x:-c.z, y:-c.x, z:-c.y}; }
export function rotateAxial(a, steps60){
  let c = cubeFromAxial(a);
  const n = ((steps60%6)+6)%6;
  for(let i=0;i<n;i++) c = rotate60Cube(c);
  return axialFromCube(c);
}
export function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}
