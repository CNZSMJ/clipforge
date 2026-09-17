// Test-only isolated database. Never seed a user's configured data directory.
const path = require('node:path'), fs = require('node:fs');
if (process.env.KEYFRAME_BROWSER_TEST !== '1' || !process.env.APP_DATA_DIR) throw new Error('Set KEYFRAME_BROWSER_TEST=1 and a dedicated APP_DATA_DIR');
const root = path.resolve(process.env.APP_DATA_DIR);
if (!path.basename(root).startsWith('keyframe-browser-')) throw new Error('Use a keyframe-browser-* scratch directory');
fs.mkdirSync(root, {recursive:true});
const {createRequire} = require('node:module'); const requireApp = createRequire(path.join(process.cwd(), 'package.json'));
const Database = requireApp('better-sqlite3'); const {drizzle} = requireApp('drizzle-orm/better-sqlite3'); const {migrate} = requireApp('drizzle-orm/better-sqlite3/migrator');
const db = new Database(path.join(root, 'sqlite.db')); migrate(drizzle(db), {migrationsFolder:path.join(process.cwd(), 'drizzle')});
const now = Math.floor(Date.now()/1000); const p='keyframe-ui-coffee';
const shots = [
 {shotId:1,type:'hook',description:'晨间厨房，镜头先让观众看清咖啡机出液口与托盘上空杯的关系。准备接咖啡，尚未启动萃取。',camera:'平视三分之二侧面，中近景',duration:4,voiceover:'早晨，先把这一杯的位置放对。',visualSource:'ai_generate',transition:'direct_concat'},
 {shotId:2,type:'demo',description:'同一厨房与咖啡机，空杯留在出液口正下方。右手只按启动键，躯干朝向机器，不转身看镜头。',camera:'手部近景，清楚显示触点',duration:5,voiceover:'一个动作，然后等香气慢慢出来。',visualSource:'ai_generate',transition:'direct_concat'},
 {shotId:3,type:'product_reveal',description:'同一咖啡机与白杯，咖啡已在杯底形成少量液面。停留在真实的接取状态，不重放按键动作。',camera:'杯口与出液口细节特写',duration:4,voiceover:'',visualSource:'ai_generate',transition:'direct_concat'}
];
db.prepare('INSERT OR IGNORE INTO projects (id,name,product_name,product_category,product_description,video_mode,status,created_at,updated_at,product_images) VALUES (?,?,?,?,?,?,?,?,?,?)').run(p,'咖啡晨间 · 画面工作台测试','咖啡机','home','本地 UI 测试，不是真实生图结果。','scene_demo','assets',now,now,JSON.stringify([`/api/files/${p}/product.png`]));
db.prepare('INSERT OR IGNORE INTO scripts (id,project_id,style_type,title,total_duration,shots,selected,created_at) VALUES (?,?,?,?,?,?,?,?)').run('ui-storyboard',p,'scene','晨间一杯',13,JSON.stringify(shots),1,now);
db.prepare('INSERT OR IGNORE INTO assets (id,project_id,shot_id,type,file_path,selected,status,created_at) VALUES (?,?,?,?,?,?,?,?)').run('ui-sample',p,1,'user_upload',`/api/files/${p}/sample.png`,1,'done',now);
const style={medium:'photography',palette:'自然白与浅木色，咖啡机保持原色',lighting:'厨房西侧柔和窗光，低对比',texture:'保留真实家居材质，干净但不塑料化'};
const workspace={version:1,style,scenes:[{id:'kitchen',name:'厨房 · 晨间',layout:'咖啡机位于北侧台面；窗在西侧；白杯位于出液口下方的滴水托盘。',lighting:'西侧窗光'}],specs:shots.map(s=>({shotId:s.shotId,sceneId:'kitchen',moment:s.shotId===1?'空的白色陶瓷杯已经静置在咖啡机出液口正下方，机器尚未出液。':s.shotId===2?'右手食指接近咖啡机启动按钮，杯子仍静置在滴水托盘上。':'咖啡机正在向托盘上的白杯出液，杯底少量咖啡，其他物件未移动。',framing:s.camera,blocking:'机身正立于台面；操作侧面构图，人物躯干朝机器，脸不入镜。',gaze:'如露出头部则注视操作区，不看镜头。',hands:s.shotId===2?'右手食指按启动键，左手不执行动作。':'手自然留在画外，不触碰正在出液的杯子。',contacts:'杯底由滴水托盘支撑，出液口对准杯口；机器底座完整接触台面。',state:s.shotId===3?'杯内少量咖啡；按钮操作已完成。':'杯子为空，托盘和机器没有移动。',productVisible:true,characterIds:[]})),references:[],approvals:[]};
db.prepare('INSERT OR REPLACE INTO keyframe_workspaces (project_id,revision,document) VALUES (?,?,?)').run(p,1,JSON.stringify(workspace)); db.close();
const dir = path.join(root, 'uploads', p); fs.mkdirSync(dir, {recursive:true});
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAYElEQVR4nO3PQQ0AIBDAMMC/50MEj4ZkVbDtmVk/OzrgVQNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgPaBXKqA31N0fbGAAAAAElFTkSuQmCC', 'base64');
for (const name of ['product.png', 'sample.png', 'layout.png']) fs.writeFileSync(path.join(dir, name), png);
console.log('Seeded isolated keyframe browser fixture:', p);
