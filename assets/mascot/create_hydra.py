"""Original HYDRAQ three-headed companion; reproducible isolated Blender build.
Run: blender --background --factory-startup --python assets/mascot/create_hydra.py
No user scenes or account data are loaded.
"""
import bpy, math, os, json, sys
from mathutils import Vector, Matrix, Quaternion
from math import sin, cos, pi
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'public', 'mascot-hydra.glb')
BLEND = os.path.join(ROOT, 'assets', 'mascot', 'hydra.blend')
PREVIEW = os.path.join(ROOT, 'output', 'hydra-model-preview.png')
bpy.context.preferences.filepaths.save_version=0
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
for data in list(bpy.data.materials): bpy.data.materials.remove(data)
scene=bpy.context.scene
scene.render.fps=30

# Colors are linear shader values; the mint underside and warm accents preserve the identity.
def material(name, rgba, rough=.48, metallic=0.0, emission=0.0):
    m=bpy.data.materials.new(name); m.diffuse_color=(*rgba[:3],1); m.use_nodes=True
    bsdf=next(n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value=(*rgba[:3],1)
    bsdf.inputs['Roughness'].default_value=rough
    bsdf.inputs['Metallic'].default_value=metallic
    if 'Subsurface Weight' in bsdf.inputs: bsdf.inputs['Subsurface Weight'].default_value=.05
    if emission and 'Emission Color' in bsdf.inputs:
        bsdf.inputs['Emission Color'].default_value=(*rgba[:3],1);bsdf.inputs['Emission Strength'].default_value=emission
    return m
skin=material('Skin_Teal',(.012,.215,.16),.42)
skinlight=material('Skin_Highlight',(.025,.32,.235),.45)
belly=material('Belly_Mint',(.31,.54,.30),.58)
plate=material('Belly_Plates',(.37,.59,.33),.56)
horn=material('Horn_Amber',(.83,.47,.105),.34)
horntip=material('Horn_Tip',(.98,.73,.25),.35)
eyeWhite=material('Eye_White',(.89,.93,.81),.18)
iris=material('Iris',(.10,.59,.36),.22,emission=.13)
pupil=material('Pupil',(.006,.018,.020),.12)
shine=material('Eye_Catchlight',(.98,1.0,.98),.12,emission=.7)
mouth=material('Mouth_Interior',(.085,.025,.029),.6)
tongue=material('Tongue',(.72,.20,.26),.52)
nostril=material('Nostril',(.012,.07,.055),.6)
mesh_objects=[]

def bind(obj,bone):
    group=obj.vertex_groups.new(name=bone);group.add(list(range(len(obj.data.vertices))),1,'REPLACE')
    obj['bone']=bone;mesh_objects.append(obj)
    return obj

def smooth(obj):
    for poly in obj.data.polygons:poly.use_smooth=True
    return obj

def sphere(name,loc,scale,mat,bone,segments=24,rings=16):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments,ring_count=rings,location=loc)
    obj=bpy.context.object;obj.name=name;obj.scale=scale
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    obj.data.materials.append(mat);smooth(obj);return bind(obj,bone)

def tube(name,points,radii,mat,bone=None,sides=12):
    verts=[];faces=[]
    pts=[Vector(p) for p in points]
    for i,p in enumerate(pts):
        t=(pts[min(i+1,len(pts)-1)]-pts[max(i-1,0)]).normalized()
        a=t.cross(Vector((0,1,0)))
        if a.length<.01:a=t.cross(Vector((1,0,0)))
        a.normalize();b=t.cross(a).normalized()
        for j in range(sides):
            q=p+radii[i]*(cos(j*2*pi/sides)*a+sin(j*2*pi/sides)*b);verts.append(tuple(q))
    for i in range(len(pts)-1):
        for j in range(sides):faces.append((i*sides+j,i*sides+(j+1)%sides,(i+1)*sides+(j+1)%sides,(i+1)*sides+j))
    faces.append(tuple(reversed(range(sides))));faces.append(tuple((len(pts)-1)*sides+j for j in range(sides)))
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.update()
    obj=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(obj);obj.data.materials.append(mat);smooth(obj)
    if bone:bind(obj,bone)
    return obj

def bezier(a,b,c,d,t):return Vector(a)*(1-t)**3+3*Vector(b)*(1-t)**2*t+3*Vector(c)*(1-t)*t*t+Vector(d)*t**3

# Armature.
bpy.ops.object.armature_add(enter_editmode=True,location=(0,0,0));rig=bpy.context.object;rig.name='HydraRig'
rig.data.name='HydraSkeleton';rig.data.edit_bones.remove(rig.data.edit_bones[0])
rest={}
def bone(name,a,b,parent=None):
    bo=rig.data.edit_bones.new(name);bo.head=a;bo.tail=b
    if parent:bo.parent=rig.data.edit_bones[parent]
    rest[name]=(Vector(a),Vector(b));return bo
bone('Root',(0,0,0),(0,0,.5))
bone('Body',(0,.16,.65),(0,.16,1.45),'Root')
heads=[(-.76,-.10,2.20),(0,-.02,2.73),(.77,.015,2.25)]
curves=[]
for i,(x,y,z) in enumerate(heads):
    root=[(-.35,.05,1.32),(0,.12,1.47),(.35,.10,1.33)][i]
    curve=(root,(x*.70,.04,1.7),(x,y+.08,z-.52),(x,y+.06,z-.15));curves.append(curve)
    for j in range(3):bone(f'Neck_{i}_{j}',bezier(*curve,j/3),bezier(*curve,(j+1)/3),'Body' if j==0 else f'Neck_{i}_{j-1}')
    bone(f'Head_{i}',(x,y+.06,z-.15),(x,y+.06,z+.30),f'Neck_{i}_2')
    bone(f'Jaw_{i}',(x,y-.08,z-.22),(x,y-.38,z-.22),f'Head_{i}')
    for side,dx in [('L',-.185),('R',.185)]:
        e=(x+dx,y-.31,z+.055)
        bone(f'Eye_{i}_{side}',e,(e[0],e[1]-.10,e[2]),f'Head_{i}')
        p=(e[0],e[1]-.116,e[2])
        bone(f'EyePivot_{i}_{side}',p,(p[0],p[1]-.07,p[2]),f'Eye_{i}_{side}')
legs=[]
for i,(x,y) in enumerate([(-.47,.42),(.47,.42),(-.48,-.18),(.48,-.18)]):
    h=Vector((x,y,.83));k=Vector((x*1.17,y-.08,.47));a=Vector((x*1.20,y-.025,.20));toe=a+Vector((0,-.22,-.025));legs.append((h,k,a,toe))
    bone(f'Leg_{i}_Upper',h,k,'Body');bone(f'Leg_{i}_Lower',k,a,f'Leg_{i}_Upper');bone(f'Leg_{i}_Paw',a,toe,f'Leg_{i}_Lower')
tail_curve=((.42,.40,.99),(.98,.74,.75),(1.30,.69,.69),(1.40,.36,1.25))
for j in range(4):bone(f'Tail_{j}',bezier(*tail_curve,j/4),bezier(*tail_curve,(j+1)/4),'Body' if j==0 else f'Tail_{j-1}')
bpy.ops.object.mode_set(mode='OBJECT')
for bo in rig.pose.bones:bo.rotation_mode='XYZ'

# Plump main body and overlapping underside scutes.
sphere('Body',(0,.18,1.04),(.72,.52,.70),skin,'Body',32,24)
sphere('Chest',(0,-.14,1.10),(.48,.245,.56),belly,'Body',28,20)
for k in range(5):
    z=.76+k*.15; profile=math.sqrt(max(.05,1-((z-1.10)/.56)**2)); w=.44*profile
    sphere(f'BellyScute_{k}',(0,-.14-.245*profile-.014,z),(w,.034,.068),plate,'Body',24,10)
# subtle back scales and ridge
for side in [-1,1]:
    for k in range(5):sphere(f'BodyScale_{side}_{k}',(side*(.46+.055*sin(k)),.12+(k%2)*.09,1.08+k*.09),(.075,.025,.055),skinlight,'Body',12,8)
for j in range(4):
    z=1.16+j*.14
    tube(f'BackSpine_{j}',[(0,.55,z),(0,.66,z+.10),(0,.68,z+.22)],[.10,.065,.006],horn,'Body',10)

# Neck meshes: real continuous deforming surfaces with smooth blend weights.
def weighted_tube(name,curve,radius_start,radius_end,prefix,count,mat,front_stripe=False):
    points=[bezier(*curve,k/30) for k in range(31)]
    obj=tube(name,points,[radius_start+(radius_end-radius_start)*(k/30) for k in range(31)],mat,None,16)
    if front_stripe:
        obj.data.materials.append(belly)
        for poly in obj.data.polygons:
            if len(poly.vertices)==4:
                co=sum((obj.data.vertices[v].co for v in poly.vertices),Vector())/4
                t=min(1,max(0,(poly.index//16+.5)/30));center=bezier(*curve,t)
                if co.y<center.y-.09:poly.material_index=1
    for j in range(count):obj.vertex_groups.new(name=f'{prefix}_{j}')
    for k in range(31):
        t=k/30;u=t*count-.5;low=max(0,min(count-1,math.floor(u)));high=max(0,min(count-1,math.floor(u)+1));f=u-math.floor(u)
        indices=list(range(k*16,k*16+16))
        if low==high:obj.vertex_groups[low].add(indices,1,'REPLACE')
        else:obj.vertex_groups[low].add(indices,1-f,'REPLACE');obj.vertex_groups[high].add(indices,f,'REPLACE')
    mesh_objects.append(obj);return obj
for i,curve in enumerate(curves):
    weighted_tube(f'NeckSkin_{i}',curve,.235,.195,f'Neck_{i}',3,skin,True)
    # Sculpted collar ridges at the base, rather than separate mechanical neck pieces.
    # Continuous neck intersects the torso without a rigid collar.

# Heads: expressive eyes, broad mint muzzle, amber horns, ear fins and brow pads.
for i,(x,y,z) in enumerate(heads):
    hb=f'Head_{i}'
    sphere(f'HeadSkull_{i}',(x,y,z),(.455,.335,.38),skin,hb,32,24)
    sphere(f'Forehead_{i}',(x,y-.09,z+.17),(.33,.27,.24),skinlight,hb,24,16)
    sphere(f'Muzzle_{i}',(x,y-.295,z-.14),(.36,.255,.205),belly,hb,28,18)
    # lips and lower jaw open independently in the Talk clip.
    sphere(f'MouthCavity_{i}',(x,y-.392,z-.248),(.247,.075,.070),mouth,hb,24,12)
    sphere(f'LowerJaw_{i}',(x,y-.297,z-.281),(.285,.185,.091),belly,f'Jaw_{i}',24,12)
    sphere(f'Tongue_{i}',(x,y-.405,z-.241),(.125,.055,.025),tongue,f'Jaw_{i}',16,8)
    # A smile sculpted as curved dark line along the broad muzzle.
    smile=[]
    for k in range(15):
        u=-1+2*k/14;smile.append((x+.248*u,y-.504+.045*u*u,z-.229+.063*u*u))
    tube(f'Smile_{i}',smile,[.012]*15,mouth,hb,8)
    for side,dx in [('L',-.185),('R',.185)]:
        eb=f'Eye_{i}_{side}';pb=f'EyePivot_{i}_{side}'
        sphere(f'EyeWhite_{i}_{side}',(x+dx,y-.306,z+.055),(.166,.105,.204),eyeWhite,eb,28,20)
        sphere(f'Iris_{i}_{side}',(x+dx,y-.408,z+.055),(.105,.025,.137),iris,pb,24,16)
        sphere(f'Pupil_{i}_{side}',(x+dx,y-.432,z+.055),(.054,.014,.099),pupil,pb,24,16)
        sphere(f'Catchlight_{i}_{side}',(x+dx-.029,y-.448,z+.107),(.031,.009,.039),shine,pb,16,10)
        sphere(f'CatchlightSmall_{i}_{side}',(x+dx+.024,y-.447,z+.012),(.013,.006,.016),shine,pb,12,8)
        sphere(f'Brow_{i}_{side}',(x+dx,y-.295,z+.237),(.18,.075,.055),skinlight,hb,24,10)
        sphere(f'Nostril_{i}_{side}',(x+dx*.58,y-.524,z-.085),(.032,.010,.022),nostril,hb,16,10)
        sign=-1 if side=='L' else 1
        # Rounded crown horns taper naturally with a bent tip.
        hornpts=[(x+sign*.26,y+.04,z+.265),(x+sign*.29,y+.09,z+.41),(x+sign*.27,y+.16,z+.56)]
        tube(f'Horn_{i}_{side}',hornpts,[.105,.072,.002],horn,hb,16)
        sphere(f'HornBase_{i}_{side}',hornpts[0],(.11,.10,.08),skin,hb,16,10)
        # side fin/ear made as a smooth leaf-like tapered lobe.
        earpoints=[(x+sign*.36,y+.02,z+.07),(x+sign*.49,y+.015,z+.13),(x+sign*.55,y+.08,z+.29)]
        ear=tube(f'Ear_{i}_{side}',earpoints,[.13,.105,.002],skinlight,hb,12)
        # Flatten only the ear mesh front/back around its own plane.
        for vertex in ear.data.vertices:vertex.co.y=y+(vertex.co.y-y)*.48
        earinner=tube(f'EarInner_{i}_{side}',[(x+sign*.40,y-.055,z+.10),(x+sign*.49,y-.045,z+.18),(x+sign*.53,y+.01,z+.26)],[.055,.045,.001],belly,hb,10)
        for vertex in earinner.data.vertices:vertex.co.y=y-.04+(vertex.co.y-(y-.04))*.25
        for j in range(3):
            sphere(f'Freckle_{i}_{side}_{j}',(x+sign*(.255+.032*j),y-.356+.013*j,z-.081-.035*(j%2)),(.018,.012,.018),horn,hb,10,6)
    # Three soft dark teal crown scales.
    for j in range(3):sphere(f'CrownScale_{i}_{j}',(x+(j-1)*.09,y-.03,z+.36),(.065,.10,.075),skin,hb,16,10)

# Legs and grounded paws; all upper/lower joints rotate independently.
for i,(h,k,a,toe) in enumerate(legs):
    sphere(f'HipRound_{i}',h,(.215,.20,.235),skin,f'Leg_{i}_Upper',24,16)
    for label,start,end,ra,rb in [('Upper',h,k,.165,.135),('Lower',k,a,.135,.115)]:
        points=[start.lerp(end,t/8) for t in range(9)]
        tube(f'LegSkin_{i}_{label}',points,[ra+(rb-ra)*t/8 for t in range(9)],skin,f'Leg_{i}_{label}',16)
        sphere(f'LegJoint_{i}_{label}',end,(rb*1.11,rb*1.11,rb*1.12),skin,f'Leg_{i}_{label}',24,16)
    sphere(f'Paw_{i}',a+Vector((0,-.10,-.018)),(.20,.265,.155),skin,f'Leg_{i}_Paw',24,16)
    for j in range(3):
        co=a+Vector(((j-1)*.095,-.272,-.02))
        sphere(f'Toe_{i}_{j}',co,(.056,.08,.046),belly,f'Leg_{i}_Paw',16,10)
        sphere(f'Claw_{i}_{j}',co+Vector((0,-.047,.010)),(.032,.042,.024),horn,f'Leg_{i}_Paw',12,8)

# Curled tail, deforming in four weighted segments.
weighted_tube('TailSkin',tail_curve,.24,.035,'Tail',4,skin)
end=bezier(*tail_curve,1)
sphere('TailLeaf',end+Vector((.01,0,.03)),(.14,.09,.20),skinlight,'Tail_3',20,14)
for j in range(5):
    t=.17+j*.16;p=bezier(*tail_curve,t);r=.12*(1-t)+.03
    tube(f'TailSpine_{j}',[p+Vector((0,0,.10)),p+Vector((0,0,.10+r*1.4))],[r*.65,.002],horn,f'Tail_{min(3,int(t*4))}',10)

# Combine all meshes into one skinned mesh: shared materials stay a small set of glTF primitives.
bpy.ops.object.select_all(action='DESELECT')
for obj in mesh_objects:obj.select_set(True)
bpy.context.view_layer.objects.active=mesh_objects[0];bpy.ops.object.join();mesh=bpy.context.object;mesh.name='HydraSkin'
mod=mesh.modifiers.new('Hydra deformation','ARMATURE');mod.object=rig;mesh.parent=rig
# place the entire scene mesh transforms in the armature's coordinate space.
for poly in mesh.data.polygons:poly.use_smooth=True

# Animation curves. Bone transforms are keyed explicitly for export and blending.
def reset_pose():
    for pb in rig.pose.bones:pb.location=(0,0,0);pb.rotation_euler=(0,0,0);pb.scale=(1,1,1)
def pose_eye_blink(frame,length=120,phase=0):
    # Soft closures at staggered moments; bones' local Z is the vertical eye dimension.
    p=(frame+phase)%length
    return .07 if 42<=p<=44 else (.55 if p in [41,45] else 1.)
def make_action(name,length,animate):
    rig.animation_data_create();rig.animation_data.action=None
    action=bpy.data.actions.new(name);rig.animation_data.action=action
    for frame in range(1,length+2):
        reset_pose();animate(frame-1,length)
        for pb in rig.pose.bones:
            pb.keyframe_insert('location',frame=frame,group=pb.name)
            pb.keyframe_insert('rotation_euler',frame=frame,group=pb.name)
            pb.keyframe_insert('scale',frame=frame,group=pb.name)
    action.use_fake_user=True
    return action

def common(frame,length,energy=1):
    t=2*pi*frame/length
    rig.pose.bones['Body'].scale=(1+.012*sin(2*pi*frame/length),1+.018*sin(2*pi*frame/length),1+.014*sin(2*pi*frame/length))
    for i in range(3):
        for j in range(3):
            pb=rig.pose.bones[f'Neck_{i}_{j}'];pb.rotation_euler.x=.025*energy*sin(t+i*.9+j*.35);pb.rotation_euler.z=.035*energy*sin(t+i*1.7+j*.25)
        rig.pose.bones[f'Head_{i}'].rotation_euler.y=.035*energy*sin(t+i*1.2)
        rig.pose.bones[f'Head_{i}'].rotation_euler.z=[-.075,0,.07][i]+.025*energy*sin(t+i*1.8)
        for side in ['L','R']:
            rig.pose.bones[f'Eye_{i}_{side}'].scale.z=pose_eye_blink(frame,120,i*13)
            rig.pose.bones[f'EyePivot_{i}_{side}'].rotation_euler.z=.04*sin(t+i)
    for j in range(4):rig.pose.bones[f'Tail_{j}'].rotation_euler.x=.045*sin(t+j*.6);rig.pose.bones[f'Tail_{j}'].rotation_euler.z=.07*sin(t+j*.6)

def idle(f,n):common(f,n)
def listen(f,n):
    common(f,n,.6)
    for i in range(3):
        rig.pose.bones[f'Neck_{i}_1'].rotation_euler.x+=.06
        rig.pose.bones[f'Head_{i}'].rotation_euler.z+=[-.07,.02,.08][i]
        rig.pose.bones[f'Head_{i}'].rotation_euler.x+=.05

def talk(f,n):
    common(f,n,1.5)
    t=f/30
    rig.pose.bones['Jaw_1'].rotation_euler.x=.11+.105*sin(2*pi*f/n*6)**2
    rig.pose.bones['Head_1'].rotation_euler.x+=.04*sin(2*pi*f/n*4)
    rig.pose.bones['Jaw_0'].rotation_euler.x=.03+.025*sin(2*pi*f/n*3)**2

# Walk with two-link inverse kinematics: paws stay on the support plane during stance.
def bone_pose_matrix(name, position, direction):
    rest_a,rest_b=rest[name]
    q=(rest_b-rest_a).normalized().rotation_difference(direction.normalized())
    rotation=q.to_matrix() @ rig.data.bones[name].matrix_local.to_3x3()
    matrix=rotation.to_4x4();matrix.translation=position
    rig.pose.bones[name].matrix=matrix

def walk(f,n):
    common(f,n,.55)
    t=2*pi*f/n
    body=rig.pose.bones['Body'];body.scale=(1,1,1)
    # Root stays fixed; the body settles between alternating planted diagonals.
    body.location.y=.012*(1-cos(t*2))
    body.rotation_euler.y=.025*sin(t)
    bpy.context.view_layer.update()
    delta=body.matrix @ rig.data.bones['Body'].matrix_local.inverted()
    for i,(h,k,a,toe) in enumerate(legs):
        p=(f/n+[0,.5,.5,0][i])%1.0
        stance=.64
        if p<stance:
            dy=-.17+.34*p/stance;dz=0.;pitch=0.
        else:
            u=(p-stance)/(1-stance);ease=u*u*(3-2*u)
            dy=.17-.34*ease;dz=.15*sin(pi*u);pitch=-.18*sin(pi*u)
        hip=delta@h
        ankle=a+Vector((0,dy,dz))
        vector=ankle-hip;distance=vector.length;direction=vector.normalized()
        l1=(k-h).length;l2=(a-k).length
        distance=min(distance,l1+l2-.001)
        cosine=max(-1,min(1,(l1*l1+distance*distance-l2*l2)/(2*l1*distance)))
        pole=Vector((0,-1,.1));bend=(pole-direction*pole.dot(direction)).normalized()
        knee=hip+direction*(cosine*l1)+bend*(math.sqrt(max(0,1-cosine*cosine))*l1)
        bone_pose_matrix(f'Leg_{i}_Upper',hip,knee-hip)
        bpy.context.view_layer.update()
        bone_pose_matrix(f'Leg_{i}_Lower',knee,ankle-knee)
        bpy.context.view_layer.update()
        paw_matrix=rig.data.bones[f'Leg_{i}_Paw'].matrix_local.copy();paw_matrix.translation=ankle
        if pitch:paw_matrix=Matrix.Translation(ankle) @ Matrix.Rotation(pitch,4,'X') @ paw_matrix.to_3x3().to_4x4()
        rig.pose.bones[f'Leg_{i}_Paw'].matrix=paw_matrix
    for i in range(3):rig.pose.bones[f'Head_{i}'].rotation_euler.x=.018*sin(t+i*.7)

actions=[make_action('Idle',120,idle),make_action('Walk',36,walk),make_action('Listen',120,listen),make_action('Talk',60,talk)]
rig.animation_data.action=actions[0];scene.frame_start=1;scene.frame_end=121;scene.frame_set(1)

# Lighting/camera for the editable source and review render; excluded from GLB export.
world=scene.world or bpy.data.worlds.new('Hydra Studio');scene.world=world;world.use_nodes=True
bg=next(n for n in world.node_tree.nodes if n.type=='BACKGROUND');bg.inputs[0].default_value=(.16,.21,.24,1);bg.inputs[1].default_value=.35

def area(name,loc,power,size,color):
    bpy.ops.object.light_add(type='AREA',location=loc);ob=bpy.context.object;ob.name=name;ob.data.energy=power;ob.data.shape='DISK';ob.data.size=size;ob.data.color=color;ob.rotation_euler=(Vector((0,0,1.5))-ob.location).to_track_quat('-Z','Y').to_euler()
area('Key softbox',(-3,-4,5),450,4,(.85,.96,1.0));area('Fill',(3,-2,3),300,3,(1.0,.80,.50));area('Rim',(0,3,4),550,3,(.45,1.0,.83))
bpy.ops.object.camera_add(location=(4.0,-8.5,4.0));camera=bpy.context.object;camera.name='Hydra Portrait';camera.rotation_euler=(Vector((0,0,1.55))-camera.location).to_track_quat('-Z','Y').to_euler();camera.data.type='ORTHO';camera.data.ortho_scale=4.5;scene.camera=camera
scene.render.resolution_x=900;scene.render.resolution_y=900;scene.render.resolution_percentage=100;scene.render.film_transparent=True
try:scene.render.engine='CYCLES';scene.cycles.samples=40;scene.cycles.use_denoising=True
except Exception:pass
# Save the actual rig and all actions; export only the character, never studio assets.
bpy.ops.wm.save_as_mainfile(filepath=BLEND)
bpy.ops.object.select_all(action='DESELECT');rig.select_set(True);mesh.select_set(True);bpy.context.view_layer.objects.active=rig
props=bpy.ops.export_scene.gltf.get_rna_type().properties
kwargs=dict(filepath=OUT,export_format='GLB',use_selection=True,export_animations=True,export_skins=True,export_morph=False,export_yup=True)
if 'export_animation_mode' in props:
    allowed=[e.identifier for e in props['export_animation_mode'].enum_items]
    print('ANIMATION_MODES',allowed)
    if 'ACTIONS' in allowed:kwargs['export_animation_mode']='ACTIONS'
if 'export_bake_animation' in props:kwargs['export_bake_animation']=True
if 'export_force_sampling' in props:kwargs['export_force_sampling']=True
if 'export_all_influences' in props:kwargs['export_all_influences']=False
bpy.ops.export_scene.gltf(**kwargs)
scene.render.filepath=PREVIEW
if '--no-render' not in sys.argv:bpy.ops.render.render(write_still=True)
tri=sum(len(p.vertices)-2 for p in mesh.data.polygons)
print('HYDRA_EXPORT',json.dumps({'glb':OUT,'blend':BLEND,'actions':[a.name for a in actions],'bones':len(rig.data.bones),'triangles':tri,'vertices':len(mesh.data.vertices),'materials':[m.name for m in mesh.data.materials],'bounds':[[min((mesh.matrix_world@v.co)[k] for v in mesh.data.vertices),max((mesh.matrix_world@v.co)[k] for v in mesh.data.vertices)] for k in range(3)]}))
