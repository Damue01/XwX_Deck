// Installer presentation only. NSIS owns installation, navigation and transactions.
// No application backend or additional desktop runtime is embedded here.
#define UNICODE
#define _UNICODE
#define NOMINMAX
#include <windows.h>
#include <windowsx.h>
#include <commctrl.h>
#include <uxtheme.h>
#include <gdiplus.h>
#include <shobjidl.h>
#include <shlobj.h>
#include <cmath>
#include <cstdint>
#include <algorithm>
#include <process.h>
using namespace Gdiplus;
static HWND mainWindow;
static HWND activePage;
static int dpi = 96;
static HBRUSH white;
static HFONT regular, titleFont, headingFont, mono, versionFont;
static HBITMAP field;
static ULONG_PTR graphicsToken;
static int px(int n);
static ULONGLONG folderStarted;
static int folderOpenMs=-1;
static void CALLBACK folderShown(HWINEVENTHOOK,DWORD,HWND window,LONG object,LONG,DWORD,DWORD) {
  wchar_t name[32];
  if(folderOpenMs<0&&object==OBJID_WINDOW&&GetClassName(window,name,32)&&wcscmp(name,L"#32770")==0)
    folderOpenMs=int(GetTickCount64()-folderStarted);
}
struct FolderRequest { HWND owner;const wchar_t* initial;wchar_t* output;int capacity;int result=-1; };
// A dedicated STA keeps slow shell extensions and unavailable paths off the installer UI thread.
static unsigned __stdcall chooseFolder(void* context) {
  auto& request=*static_cast<FolderRequest*>(context);
  HRESULT init=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);
  if(FAILED(init))return 0;
  IFileOpenDialog* dialog=nullptr;
  HRESULT result=CoCreateInstance(CLSID_FileOpenDialog,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&dialog));
  if(SUCCEEDED(result)) {
    DWORD options=0;dialog->GetOptions(&options);
    dialog->SetOptions(options|FOS_PICKFOLDERS|FOS_FORCEFILESYSTEM|FOS_DONTADDTORECENT|FOS_NOCHANGEDIR);
    // Keep this picker's saved shell state separate from other applications' remote/recent folders.
    const GUID client={0xb8bb170a,0x5604,0x4a87,{0x9f,0x55,0x1e,0x53,0xaf,0x80,0xc3,0x91}};
    dialog->SetClientGuid(client);
    dialog->SetTitle(L"选择安装位置");
    IShellItem* start=nullptr;
    wchar_t folder[32768]={};
    if(request.initial&&wcslen(request.initial)<32768)wcscpy_s(folder,request.initial);
    wchar_t root[4]={folder[0],L':',L'\\',0};
    // Probing an offline UNC or mapped drive can block for Windows' network timeout.
    if(folder[1]!=L':'||GetDriveType(root)!=DRIVE_FIXED)folder[0]=0;
    // A first install's final folder does not exist yet. Start at its nearest
    // existing parent instead of loading the user's potentially remote Home view.
    while(folder[0]) {
      DWORD attributes=GetFileAttributes(folder);
      if(attributes!=INVALID_FILE_ATTRIBUTES&&(attributes&FILE_ATTRIBUTE_DIRECTORY))break;
      wchar_t* slash=wcsrchr(folder,L'\\');if(!slash)slash=wcsrchr(folder,L'/');
      if(!slash){folder[0]=0;break;}if(slash==folder+2&&folder[1]==L':'){slash[1]=0;break;}*slash=0;
    }
    if(!folder[0]){GetWindowsDirectory(folder,32768);folder[3]=0;}
    if(SUCCEEDED(SHCreateItemFromParsingName(folder,nullptr,IID_PPV_ARGS(&start)))){dialog->SetFolder(start);start->Release();}
    auto hook=SetWinEventHook(EVENT_OBJECT_SHOW,EVENT_OBJECT_SHOW,nullptr,folderShown,GetCurrentProcessId(),GetCurrentThreadId(),WINEVENT_OUTOFCONTEXT);
    result=dialog->Show(request.owner);
    if(hook)UnhookWinEvent(hook);
    if(SUCCEEDED(result)) {
      IShellItem* item=nullptr;
      result=dialog->GetResult(&item);
      if(SUCCEEDED(result)) {
        PWSTR path=nullptr;result=item->GetDisplayName(SIGDN_FILESYSPATH,&path);
        if(SUCCEEDED(result)){if(wcslen(path)<size_t(request.capacity))wcscpy_s(request.output,request.capacity,path);else result=E_INVALIDARG;CoTaskMemFree(path);}
        item->Release();
      }
    }
    dialog->Release();
  }
  CoUninitialize();
  request.result=SUCCEEDED(result)?1:result==HRESULT_FROM_WIN32(ERROR_CANCELLED)?0:-1;
  return 0;
}
// Use the same modern shell dialog family as the application's image picker.
extern "C" int __stdcall ChooseFolder(HWND owner,const wchar_t* initial,wchar_t* output,int capacity) {
  if(!output||capacity<1)return -1;
  output[0]=0;folderOpenMs=-1;folderStarted=GetTickCount64();
  FolderRequest request{owner,initial,output,capacity};
  bool enabled=owner&&IsWindowEnabled(owner);
  if(enabled)EnableWindow(owner,FALSE);
  HANDLE thread=reinterpret_cast<HANDLE>(_beginthreadex(nullptr,0,chooseFolder,&request,0,nullptr));
  if(thread){
    MSG message;bool quit=false;int quitCode=0;
    while(MsgWaitForMultipleObjects(1,&thread,FALSE,INFINITE,QS_ALLINPUT)!=WAIT_OBJECT_0){
      while(PeekMessage(&message,nullptr,0,0,PM_REMOVE)){
        if(message.message==WM_QUIT){quit=true;quitCode=int(message.wParam);}
        else{TranslateMessage(&message);DispatchMessage(&message);}
      }
    }
    CloseHandle(thread);
    if(quit)PostQuitMessage(quitCode);
  }
  if(enabled){EnableWindow(owner,TRUE);SetForegroundWindow(owner);}
  return request.result;
}
extern "C" int __stdcall FolderOpenMilliseconds() {
  return folderOpenMs;
}
static LRESULT CALLBACK checkboxProc(HWND window,UINT msg,WPARAM wp,LPARAM lp,UINT_PTR,DWORD_PTR) {
  if(msg==WM_ERASEBKGND)return 1;
  if(msg==WM_PAINT){
    PAINTSTRUCT paint;HDC dc=BeginPaint(window,&paint);RECT r;GetClientRect(window,&r);FillRect(dc,&r,white);
    bool checked=SendMessage(window,BM_GETCHECK,0,0)==BST_CHECKED;
    RECT box={0,(r.bottom-px(16))/2,px(16),(r.bottom+px(16))/2};
    HPEN pen=CreatePen(PS_SOLID,px(1),checked?RGB(23,24,26):RGB(130,132,135));HBRUSH brush=CreateSolidBrush(checked?RGB(23,24,26):RGB(255,255,255));
    auto oldPen=SelectObject(dc,pen),oldBrush=SelectObject(dc,brush);RoundRect(dc,box.left,box.top,box.right,box.bottom,px(6),px(6));SelectObject(dc,oldPen);SelectObject(dc,oldBrush);DeleteObject(pen);DeleteObject(brush);
    if(checked){pen=CreatePen(PS_SOLID,px(2),RGB(255,255,255));oldPen=SelectObject(dc,pen);POINT points[]={{px(4),box.top+px(8)},{px(7),box.top+px(11)},{px(12),box.top+px(5)}};Polyline(dc,points,3);SelectObject(dc,oldPen);DeleteObject(pen);}
    r.left=px(24);SetBkMode(dc,TRANSPARENT);SetTextColor(dc,RGB(23,24,26));auto font=SelectObject(dc,regular);wchar_t text[256];GetWindowText(window,text,256);DrawText(dc,text,-1,&r,DT_SINGLELINE|DT_VCENTER|DT_NOPREFIX);SelectObject(dc,font);
    if(GetFocus()==window){InflateRect(&r,-1,-px(3));DrawFocusRect(dc,&r);}EndPaint(window,&paint);return 0;
  }
  auto result=DefSubclassProc(window,msg,wp,lp);
  if(msg==BM_SETCHECK||msg==WM_LBUTTONUP||msg==WM_KEYUP||msg==WM_SETFOCUS||msg==WM_KILLFOCUS)InvalidateRect(window,nullptr,TRUE);
  return result;
}
static LRESULT CALLBACK editProc(HWND window,UINT msg,WPARAM wp,LPARAM lp,UINT_PTR,DWORD_PTR) {
  if(msg==WM_GETDLGCODE&&lp&&(((MSG*)lp)->wParam==VK_RETURN||((MSG*)lp)->wParam==VK_ESCAPE))return DLGC_WANTMESSAGE;
  if(msg==WM_KEYDOWN&&wp==VK_RETURN){if(IsWindowEnabled(GetDlgItem(mainWindow,IDOK)))PostMessage(mainWindow,WM_COMMAND,IDOK,0);return 0;}
  if(msg==WM_KEYDOWN&&wp==VK_ESCAPE){if(IsWindowEnabled(GetDlgItem(mainWindow,IDCANCEL)))PostMessage(mainWindow,WM_COMMAND,IDCANCEL,0);return 0;}
  return DefSubclassProc(window,msg,wp,lp);
}
static LRESULT CALLBACK buttonProc(HWND window,UINT msg,WPARAM wp,LPARAM lp,UINT_PTR,DWORD_PTR) {
  // Dialog focus/default-button handling must not replace the branded drawing style.
  if(msg==BM_SETSTYLE){auto result=DefSubclassProc(window,msg,(wp&~BS_TYPEMASK)|BS_OWNERDRAW,lp);InvalidateRect(window,nullptr,TRUE);return result;}
  if(msg==WM_STYLECHANGING&&wp==(WPARAM)GWL_STYLE){auto style=(STYLESTRUCT*)lp;style->styleNew=(style->styleNew&~BS_TYPEMASK)|BS_OWNERDRAW;}
  if(msg==WM_UPDATEUISTATE){auto result=DefSubclassProc(window,msg,wp,lp);InvalidateRect(window,nullptr,TRUE);return result;}
  if(msg==WM_MOUSEMOVE&&!GetProp(window,L"hover")){SetProp(window,L"hover",(HANDLE)1);TRACKMOUSEEVENT event={sizeof(event),TME_LEAVE,window,0};TrackMouseEvent(&event);InvalidateRect(window,nullptr,TRUE);}
  if(msg==WM_MOUSELEAVE){RemoveProp(window,L"hover");InvalidateRect(window,nullptr,TRUE);}
  if(msg==WM_GETDLGCODE)return DLGC_BUTTON|((lp&&(((MSG*)lp)->wParam==VK_RETURN||((MSG*)lp)->wParam==VK_ESCAPE))?DLGC_WANTMESSAGE:0)|(GetDlgCtrlID(window)==IDOK?DLGC_DEFPUSHBUTTON:DLGC_UNDEFPUSHBUTTON);
  if(msg==WM_KEYDOWN&&wp==VK_RETURN){SendMessage(window,BM_CLICK,0,0);return 0;}
  if(msg==WM_KEYDOWN&&wp==VK_ESCAPE){if(IsWindowEnabled(GetDlgItem(mainWindow,IDCANCEL)))PostMessage(mainWindow,WM_COMMAND,IDCANCEL,0);return 0;}
  return DefSubclassProc(window,msg,wp,lp);
}
static int px(int n) { return MulDiv(n, dpi, 96); }
static double smooth(double a, double b, double v) { double x = std::clamp((v-a)/(b-a),0.,1.); return x*x*(3-2*x); }
static double mix(double a, double b, double t) { return a+(b-a)*t; }
static double hash(int x, int y) { uint32_t n=uint32_t(x)*374761393u+uint32_t(y)*668265263u; n=(n^(n>>13))*1274126177u; return double(n^(n>>16))/4294967295.; }
static double noise(double x,double y) { int ix=int(floor(x)),iy=int(floor(y));double fx=x-ix,fy=y-iy,ux=fx*fx*(3-2*fx),uy=fy*fy*(3-2*fy);return mix(mix(hash(ix,iy),hash(ix+1,iy),ux),mix(hash(ix,iy+1),hash(ix+1,iy+1),ux),uy); }
static double fbm(double x,double y) { double v=0,w=.5,total=0;for(int i=0;i<4;i++){v+=noise(x,y)*w;total+=w;x=x*2.03+17.1;y=y*2.03+9.2;w*=.5;}return v/total; }
static double clearance(double x,double y,double cx,double cy,double sx,double sy,double strength) { return 1-strength*exp(-((x-cx)*(x-cx)/(2*sx*sx)+(y-cy)*(y-cy)/(2*sy*sy))); }
static void makeField() {
  GdiplusStartupInput input; GdiplusStartup(&graphicsToken,&input,nullptr);
  Bitmap bitmap(px(620),px(240),PixelFormat32bppARGB);Graphics g(&bitmap);g.Clear(Color::White);g.SetSmoothingMode(SmoothingModeAntiAlias);g.ScaleTransform(float(dpi)/96,float(dpi)/96);
  // Original C edge field, frozen at the accepted preview's t=83*.4.
  const double step=6.5,t=83*.4,w=620,h=240;
  for(double y=0;y<h;y+=step)for(double x=0;x<w;x+=step){double gx=x/step,gy=y/step;
    double wx=fbm(gx*.038+t*.22,gy*.038+4.1)-.5,wy=fbm(gx*.038+8.2,gy*.038-t*.17)-.5;
    double n1=fbm(gx*.058+wx*.92+t*.52,gy*.058+wy*.92+t*.13),n2=fbm(gx*.030-t*.10,gy*.030+t*.18),fine=fbm(gx*.115-t*.14,gy*.115+t*.10);
    double main=std::clamp(((n1*.76+n2*.18-.008)-.5)*1.04+.5,0.,1.);
    double speckles=smooth(.50,.82,fine)*.12*(1-smooth(.42,.82,main));double growth=pow(smooth(.31,.81,std::min(1.,main+speckles)),1.08);
    double bottom=(1-smooth(.32,.96,x/w))*smooth(.38,.99,y/h),edges=std::max(smooth(.55,1.04,x/w),1-smooth(-.06,.38,x/w))*(1-smooth(.25,.85,y/h));
    double mask=std::max(edges,bottom*.65)*clearance(x,y,115,h-48,115,22,.97)*clearance(x,y,137,70,145,40,.98)*clearance(x,y,w*.48,h*.50,w*.43,33,.94)*clearance(x,y,w-96,h-48,85,22,.95);
    double r=step*(.028+growth*.338);if(mask<.015||r<.1)continue;SolidBrush dot(Color(BYTE(round(255*.32*mask)),23,24,26));g.FillEllipse(&dot,REAL(x-r),REAL(y-r),REAL(r*2),REAL(r*2));
  }bitmap.GetHBITMAP(Color::White,&field);
}
static void paintField(HWND window,HDC dc) {
  RECT r;GetClientRect(window,&r);POINT p={0,0};MapWindowPoints(window,mainWindow,&p,1);HDC memory=CreateCompatibleDC(dc);HGDIOBJ old=SelectObject(memory,field);BitBlt(dc,0,0,r.right,r.bottom,memory,p.x,p.y,SRCCOPY);SelectObject(memory,old);DeleteDC(memory);
  if(GetProp(window,L"folder")){HPEN pen=CreatePen(PS_SOLID,1,RGB(153,155,157));HGDIOBJ oldPen=SelectObject(dc,pen),oldBrush=SelectObject(dc,GetStockObject(NULL_BRUSH));POINT points[]={{px(227),px(113)},{px(227),px(110)},{px(232),px(110)},{px(234),px(112)},{px(239),px(112)},{px(239),px(121)},{px(227),px(121)},{px(227),px(113)},{px(239),px(113)}};Polyline(dc,points,9);SelectObject(dc,oldPen);SelectObject(dc,oldBrush);DeleteObject(pen);}
}
static LRESULT CALLBACK labelProc(HWND window,UINT msg,WPARAM wp,LPARAM lp,UINT_PTR,DWORD_PTR) {
  if(msg==WM_ERASEBKGND)return 1;
  if(msg==WM_PAINT){PAINTSTRUCT paint;HDC dc=BeginPaint(window,&paint);paintField(window,dc);RECT r;GetClientRect(window,&r);int id=GetDlgCtrlID(window);SetBkMode(dc,TRANSPARENT);SetTextColor(dc,GetProp(window,L"error")?RGB(166,52,41):id==60003?RGB(164,166,168):id==60002||GetProp(window,L"heading")?RGB(23,24,26):RGB(139,141,144));HFONT font=(HFONT)SendMessage(window,WM_GETFONT,0,0);HGDIOBJ old=SelectObject(dc,font?font:regular);wchar_t text[2048];GetWindowText(window,text,2048);DrawText(dc,text,-1,&r,DT_NOPREFIX|(id==60002||id==60003?DT_SINGLELINE:DT_WORDBREAK));SelectObject(dc,old);EndPaint(window,&paint);return 0;}
  return DefSubclassProc(window,msg,wp,lp);
}
static void move(HWND control,int x,int y,int w,int h) { SetWindowPos(control,nullptr,px(x),px(y),px(w),px(h),SWP_NOZORDER|SWP_NOACTIVATE); }
static void ownerButton(HWND button) { SetWindowTheme(button,L"",L"");SetWindowLongPtr(button,GWL_STYLE,(GetWindowLongPtr(button,GWL_STYLE)&~(BS_TYPEMASK|WS_BORDER))|BS_OWNERDRAW);SetWindowLongPtr(button,GWL_EXSTYLE,GetWindowLongPtr(button,GWL_EXSTYLE)&~(WS_EX_CLIENTEDGE|WS_EX_STATICEDGE|WS_EX_DLGMODALFRAME));SendMessage(button,WM_SETFONT,(WPARAM)regular,TRUE);SetWindowSubclass(button,buttonProc,2,0);SetWindowPos(button,nullptr,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE|SWP_FRAMECHANGED); }
static void drawButton(DRAWITEMSTRUCT* item) {
  bool primary=GetDlgCtrlID(item->hwndItem)==IDOK,close=GetDlgCtrlID(item->hwndItem)==60001;
  bool disabled=(item->itemState&ODS_DISABLED)!=0,pressed=(item->itemState&ODS_SELECTED)!=0,hover=GetProp(item->hwndItem,L"hover")!=nullptr;
  RECT r=item->rcItem;FillRect(item->hDC,&r,white);SetBkMode(item->hDC,TRANSPARENT);
  if(primary||hover){HBRUSH fill=CreateSolidBrush(primary?(disabled?RGB(161,162,164):pressed||hover?RGB(57,58,60):RGB(23,24,26)):RGB(241,241,239));HGDIOBJ oldBrush=SelectObject(item->hDC,fill),oldPen=SelectObject(item->hDC,GetStockObject(NULL_PEN));RoundRect(item->hDC,r.left,r.top,r.right,r.bottom,px(10),px(10));SelectObject(item->hDC,oldBrush);SelectObject(item->hDC,oldPen);DeleteObject(fill);}
  SetTextColor(item->hDC,primary?RGB(255,255,255):disabled?RGB(180,181,183):close?RGB(164,166,167):RGB(115,117,121));
  wchar_t text[64];GetWindowText(item->hwndItem,text,64);
  if(close){
    Graphics graphics(item->hDC);graphics.SetSmoothingMode(SmoothingModeAntiAlias);graphics.SetPixelOffsetMode(PixelOffsetModeHalf);
    Pen pen(hover?Color(90,92,95):Color(119,121,124),REAL(1.1*dpi/96));
    REAL x=REAL(r.left+r.right)/2,y=REAL(r.top+r.bottom)/2,half=REAL(4.*dpi/96);
    graphics.DrawLine(&pen,x-half,y-half,x+half,y+half);
    graphics.DrawLine(&pen,x+half,y-half,x-half,y+half);return;
  }
  for(unsigned i=0;text[i]&&text[i+1];++i)if(text[i]==L'('&&text[i+1]==L'&'){text[i]=0;break;}
  HFONT old=(HFONT)SelectObject(item->hDC,regular);DrawText(item->hDC,text,-1,&r,DT_CENTER|DT_VCENTER|DT_SINGLELINE);SelectObject(item->hDC,old);
  if((item->itemState&ODS_FOCUS)&&!(SendMessage(item->hwndItem,WM_QUERYUISTATE,0,0)&UISF_HIDEFOCUS)){
    InflateRect(&r,-px(2),-px(2));HPEN pen=CreatePen(PS_SOLID,std::max(1,px(1)),RGB(128,130,133));
    auto oldPen=SelectObject(item->hDC,pen),oldBrush=SelectObject(item->hDC,GetStockObject(NULL_BRUSH));
    RoundRect(item->hDC,r.left,r.top,r.right,r.bottom,px(8),px(8));SelectObject(item->hDC,oldPen);SelectObject(item->hDC,oldBrush);DeleteObject(pen);
  }
}
static LRESULT CALLBACK hiddenChromeProc(HWND window,UINT msg,WPARAM wp,LPARAM lp,UINT_PTR,DWORD_PTR) {
  if(msg==WM_WINDOWPOSCHANGING&&window!=activePage){auto pos=(WINDOWPOS*)lp;pos->flags=(pos->flags&~SWP_SHOWWINDOW)|SWP_HIDEWINDOW;}
  return DefSubclassProc(window,msg,wp,lp);
}
static LRESULT CALLBACK skinProc(HWND window,UINT msg,WPARAM wp,LPARAM lp,UINT_PTR,DWORD_PTR) {
  if(window==activePage&&msg==WM_WINDOWPOSCHANGING){auto pos=(WINDOWPOS*)lp;pos->x=0;pos->y=0;pos->cx=px(620);pos->cy=px(180);pos->hwndInsertAfter=HWND_BOTTOM;pos->flags&=~(SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER);}
  if(msg==WM_ERASEBKGND){paintField(window,(HDC)wp);return 1;}
  if(msg==WM_CTLCOLORSTATIC||msg==WM_CTLCOLOREDIT||msg==WM_CTLCOLORDLG){HDC dc=(HDC)wp;SetBkMode(dc,TRANSPARENT);int id=GetDlgCtrlID((HWND)lp);SetTextColor(dc,GetProp((HWND)lp,L"error")?RGB(166,52,41):id==60003?RGB(164,166,168):id==60002?RGB(23,24,26):RGB(90,92,95));return (LRESULT)white;}
  if(msg==WM_DRAWITEM){drawButton((DRAWITEMSTRUCT*)lp);return TRUE;}
  if(window==mainWindow&&msg==WM_COMMAND&&LOWORD(wp)==60001){SendMessage(window,WM_COMMAND,GetProp(window,L"finished")?IDOK:IDCANCEL,0);return 0;}
  if(msg==WM_NCHITTEST){LRESULT hit=DefSubclassProc(window,msg,wp,lp);if(hit==HTCLIENT){POINT p={GET_X_LPARAM(lp),GET_Y_LPARAM(lp)};RECT close;GetWindowRect(GetDlgItem(mainWindow,60001),&close);if(PtInRect(&close,p))return HTCLIENT;ScreenToClient(mainWindow,&p);if(p.y>=0&&p.y<px(64))return window==mainWindow?HTCAPTION:HTTRANSPARENT;}return hit;}
  return DefSubclassProc(window,msg,wp,lp);
}
static HWND label(HWND parent,int id,const wchar_t* text,int x,int y,int w,int h,HFONT font) {
  HWND control=CreateWindow(L"STATIC",text,WS_CHILD|WS_VISIBLE|SS_NOPREFIX,x,y,w,h,parent,(HMENU)(INT_PTR)id,GetModuleHandle(nullptr),nullptr);move(control,x,y,w,h);SendMessage(control,WM_SETFONT,(WPARAM)font,TRUE);SetWindowSubclass(control,labelProc,4,0);return control;
}
extern "C" void __stdcall Skin(HWND parent,HWND page,const wchar_t* version,int mode) {
  activePage=page;
  if(!mainWindow){mainWindow=parent;dpi=GetDpiForWindow(parent);white=CreateSolidBrush(RGB(255,255,255));
    regular=CreateFont(-px(11),0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,DEFAULT_PITCH,L"Microsoft YaHei UI");
    titleFont=CreateFont(-px(28),0,0,0,FW_MEDIUM,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,DEFAULT_PITCH,L"Segoe UI");
    headingFont=CreateFont(-px(15),0,0,0,FW_MEDIUM,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,DEFAULT_PITCH,L"Microsoft YaHei UI");
    mono=CreateFont(-px(11),0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,FIXED_PITCH,L"Consolas");versionFont=CreateFont(-px(9),0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,FIXED_PITCH,L"Consolas");makeField();
    RECT r;GetWindowRect(parent,&r);SetWindowLongPtr(parent,GWL_STYLE,WS_POPUP|WS_SYSMENU|WS_CLIPCHILDREN);SetWindowLongPtr(parent,GWL_EXSTYLE,WS_EX_APPWINDOW);
    SetWindowPos(parent,nullptr,(r.left+r.right-px(620))/2,(r.top+r.bottom-px(240))/2,px(620),px(240),SWP_NOZORDER|SWP_FRAMECHANGED);
    SetWindowRgn(parent,CreateRoundRectRgn(0,0,px(620)+1,px(240)+1,px(12),px(12)),TRUE);SetWindowSubclass(parent,skinProc,1,0);
    HWND close=CreateWindow(L"BUTTON",L"关闭",WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_OWNERDRAW,0,0,0,0,parent,(HMENU)60001,GetModuleHandle(nullptr),nullptr);move(close,572,8,40,40);ownerButton(close);
    label(parent,60003,version,32,196,160,16,versionFont);
    SendMessage(parent,WM_CHANGEUISTATE,MAKEWPARAM(UIS_SET,UISF_HIDEFOCUS),0);
  }
  // NSIS changes pages and button state; retain its normal keyboard/default actions.
  HWND next=GetDlgItem(parent,IDOK),cancel=GetDlgItem(parent,IDCANCEL);move(next,530,187,58,29);move(cancel,478,187,42,29);ownerButton(next);ownerButton(cancel);ShowWindow(GetDlgItem(parent,3),SW_HIDE);
  ShowWindow(next,mode==2?SW_HIDE:SW_SHOW);
  SetWindowText(cancel,L"取消");SendMessage(parent,DM_SETDEFID,IDOK,0);
  move(GetDlgItem(parent,1018),0,0,620,180);
  for(HWND child=GetWindow(parent,GW_CHILD);child;child=GetWindow(child,GW_HWNDNEXT)){int id=GetDlgCtrlID(child);if(child!=page&&child!=next&&child!=cancel&&id!=60001&&id!=60003){SetWindowSubclass(child,hiddenChromeProc,6,0);ShowWindow(child,SW_HIDE);}}
  SetWindowLongPtr(page,GWL_STYLE,GetWindowLongPtr(page,GWL_STYLE)|WS_CLIPSIBLINGS|WS_CLIPCHILDREN);
  move(page,0,0,620,180);ShowWindow(page,SW_SHOW);SetWindowSubclass(page,skinProc,1,0);
  if(mode==0)SetProp(page,L"folder",(HANDLE)1);else RemoveProp(page,L"folder");
  label(page,60002,L"XwX Deck",32,88,175,42,titleFont);
  if(mode==2){ // NSIS's real extraction/registration progress, not a timer animation.
    HWND bar=GetDlgItem(page,1004),caption=GetDlgItem(page,1006);move(bar,225,119,363,4);move(caption,225,86,363,22);SendMessage(caption,WM_SETFONT,(WPARAM)regular,TRUE);SetWindowSubclass(caption,labelProc,4,0);ShowWindow(bar,SW_SHOW);ShowWindow(caption,SW_SHOW);SetWindowTheme(bar,L"",L"");SendMessage(bar,PBM_SETBARCOLOR,0,RGB(23,24,26));SendMessage(bar,PBM_SETBKCOLOR,0,RGB(240,240,238));
  }
  if(mode==1||mode==4){ShowWindow(cancel,SW_HIDE);SetProp(parent,L"finished",(HANDLE)1);}else RemoveProp(parent,L"finished");
  HWND close=GetDlgItem(parent,60001);EnableWindow(close,mode!=2);SetWindowPos(close,HWND_TOP,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE);
  InvalidateRect(parent,nullptr,TRUE);InvalidateRect(page,nullptr,TRUE);
}
extern "C" void __stdcall Field(HWND window,int kind) {
  ShowWindow(window,SW_SHOW);
  SendMessage(window,WM_SETFONT,(WPARAM)regular,TRUE);
  if(kind==0)move(window,247,108,303,22);
  if(kind==1)move(window,558,104,36,28);
  if(kind==2)move(window,225,78,363,18);
  if(kind==3){move(window,225,140,363,34);SetProp(window,L"error",(HANDLE)1);}
  if(kind==4){move(window,225,78,363,22);SetProp(window,L"heading",(HANDLE)1);SendMessage(window,WM_SETFONT,(WPARAM)headingFont,TRUE);}
  if(kind==5){move(window,225,111,363,28);SetWindowTheme(window,L"",L"");SetWindowSubclass(window,checkboxProc,5,0);}
  if(kind==6)move(window,225,106,363,44);
  if(kind==7)move(window,225,140,363,18);
  if(kind==8)move(window,225,158,363,20);
  if(kind==2||kind==3||kind==4||kind==6||kind==7)SetWindowSubclass(window,labelProc,4,0);
  // Remove theme edges only from the editable path. Keep genuine edit/button controls.
  if(kind==0){SetWindowTheme(window,L"",L"");SetWindowLongPtr(window,GWL_STYLE,GetWindowLongPtr(window,GWL_STYLE)&~WS_BORDER);SetWindowLongPtr(window,GWL_EXSTYLE,GetWindowLongPtr(window,GWL_EXSTYLE)&~WS_EX_CLIENTEDGE);SendMessage(window,WM_SETFONT,(WPARAM)mono,TRUE);SetWindowSubclass(window,editProc,3,0);SetWindowPos(window,nullptr,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER|SWP_FRAMECHANGED);}
  else if(kind==1)ownerButton(window);
}
