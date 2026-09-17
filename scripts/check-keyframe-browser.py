from playwright.sync_api import sync_playwright
import json, pathlib, os, shutil
if os.environ.get('KEYFRAME_BROWSER_TEST') != '1':
 raise RuntimeError('This script is for isolated browser fixtures only')
base=os.environ.get('KEYFRAME_BROWSER_URL','http://localhost:3107')
data_dir=pathlib.Path(os.environ['APP_DATA_DIR'])
out=pathlib.Path(os.environ.get('KEYFRAME_BROWSER_ARTIFACTS','/tmp/keyframe-browser-evidence'));out.mkdir(parents=True,exist_ok=True)
state={'state':{'locale':'zh','localeSource':'user','uiMode':'simple','providers':{'fal-ai':{'enabled':True,'apiKey':'test-not-real','baseUrl':'https://queue.fal.run'}},'llm':{'provider':'fal.ai','baseUrl':'https://fal.run/openrouter/router/openai/v1','apiKey':'test-not-real','model':'google/gemini-3.8-flash','visionModel':'google/gemini-3.8-flash'},'defaultImageModel':'openai/gpt-image-2.5/sunburst/edit','defaultVideoModel':'bytedance/seedance-2.5/image-to-video'},'version':8}
def open_direction(studio):
 # React intentionally preserves the user's open disclosure on pin/save. Never toggle
 # blindly: closing the panel would make its reference selector inaccessible.
 panel=studio.locator('details').filter(has=studio.page.get_by_text('全片画面设定与参考图',exact=True)).first
 if not panel.evaluate('(node) => node.open'):
  panel.locator('summary').click()
 studio.get_by_label('上传参考的用途',exact=True).wait_for(state='visible')
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path=shutil.which('google-chrome') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
 context=browser.new_context(viewport={'width':1440,'height':1000},device_scale_factor=1)
 context.add_init_script('localStorage.setItem("daihuo-jianshou-settings", '+json.dumps(json.dumps(state))+');')
 page=context.new_page();errors=[];posts=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.on('request',lambda r:posts.append({'url':r.url,'method':r.method,'body':r.post_data}) if r.method in ['POST','PATCH'] else None)
 try:
  page.goto(base+'/project/keyframe-ui-coffee/assets',wait_until='domcontentloaded',timeout=90000)
  page.get_by_role('heading',name='先把画面做对，再生成视频').wait_for(timeout=60000)
  studio=page.locator('#keyframe-studio');studio.scroll_into_view_if_needed();page.wait_for_timeout(400)
  studio.screenshot(path=str(out/'desktop-initial.png'))
  print('targetbutton',studio.get_by_role('button',name='预览重做 / 修正方案').is_enabled())
  open_direction(studio)
  studio.get_by_role('button',name='极简三维',exact=True).click()
  assert not studio.get_by_role('button',name='预览重做 / 修正方案').is_enabled()
  studio.get_by_role('button',name='保存设定（免费）',exact=True).click();page.get_by_text('已保存。设定改变后旧图需重新确认；不会删除或自动重生。',exact=True).wait_for()
  studio.get_by_role('button',name='预览重做 / 修正方案',exact=True).click()
  page.get_by_text('确认本次调用',exact=True).wait_for();page.get_by_text('查看实际生图提示词',exact=True).click()
  assert 'Designed three-dimensional animation' in studio.locator('pre').inner_text()
  assert 'cup' in studio.locator('pre').inner_text().lower() or '杯' in studio.locator('pre').inner_text()
  page.locator('[aria-label="确认本次操作"]').screenshot(path=str(out/'desktop-preflight.png'))
  studio.get_by_role('button',name='取消',exact=True).click()
  # Pinning an existing valid test fixture is free and does not purchase images/video.
  studio.get_by_role('button',name='确认并设为场景样片',exact=True).click()
  page.get_by_text('已设为本场景参考。其他旧图需复核；仅同场景后续生图使用它。',exact=True).wait_for()
  assert studio.get_by_role('button',name='已确认用于视频',exact=True).is_visible()
  studio.screenshot(path=str(out/'desktop-pinned.png'))
  # Pose/layout upload -> draft save -> actual ordered preview (no inference).
  open_direction(studio)
  studio.get_by_label('上传参考的用途',exact=True).select_option('layout')
  studio.get_by_label('上传参考图',exact=True).set_input_files(str(data_dir/'uploads/keyframe-ui-coffee/layout.png'))
  page.get_by_text('参考图已上传；保存设定后使用。姿态/构图图只控制空间关系，不会作为画风。',exact=True).wait_for()
  studio.get_by_role('button',name='保存设定（免费）',exact=True).click();page.get_by_text('已保存。设定改变后旧图需重新确认；不会删除或自动重生。',exact=True).wait_for()
  studio.get_by_role('button',name='预览重做 / 修正方案',exact=True).click();page.get_by_text('查看实际生图提示词',exact=True).click()
  assert 'layout' in studio.locator('pre').inner_text()
  studio.get_by_role('button',name='取消',exact=True).click()
  # Mobile: all controls remain in the viewport; horizontal scrolling belongs only to shot strip.
  page.set_viewport_size({'width':390,'height':844});studio.scroll_into_view_if_needed();page.wait_for_timeout(350)
  overflow=page.evaluate('({viewport:innerWidth,document:document.documentElement.scrollWidth,studio:document.querySelector("#keyframe-studio").scrollWidth,client:document.querySelector("#keyframe-studio").clientWidth})')
  studio.screenshot(path=str(out/'mobile-workspace.png')); assert overflow['document'] <= overflow['viewport'], str(overflow)
  page.reload(wait_until='domcontentloaded');page.get_by_role('heading',name='先把画面做对，再生成视频').wait_for();open_direction(studio);assert 'layout.png' in studio.inner_text()
  api=page.request.get(base+'/api/project/keyframe-ui-coffee/keyframes').json()
  assert any(r['role']=='layout' for r in api['workspace']['references'])
  assert not any(json.loads(p['body'] or '{}').get('action') in ['generate','plan','check'] for p in posts if '/keyframes' in p['url'])
  result={'viewportCheck':overflow,'pageErrors':errors,'requests':[{'url':p['url'],'method':p['method'],'action':json.loads(p['body']).get('action')} for p in posts if '/keyframes' in p['url']],'reloadedReferences':len(api['workspace']['references']),'tests':['read-only startup','dirty-save guard','free style save','actual prompt preview','explicit cancel','free approval and scene pin','role-scoped real file upload','reload persistence','no paid calls'], 'fixture':'Solid-color valid raster test asset, not AI output'}
  (out/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False,indent=2))
  assert not errors, str(errors)
 except Exception as error:
  (out/'failure.json').write_text(json.dumps({'error':str(error),'pageErrors':errors,'fixture':'UI-only synthetic raster; no inference'},ensure_ascii=False,indent=2))
  try: page.screenshot(path=str(out/'browser-failure.png'),full_page=True)
  except Exception: pass
  raise
 finally:
  browser.close()
