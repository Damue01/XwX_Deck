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
#include <cmath>
#include <cstdint>
#include <algorithm>
using namespace Gdiplus;
static HWND mainWindow;
static int dpi = 96;
static HBRUSH white;
static HFONT regular, titleFont, mono, versionFont;
static HBITMAP field;
static ULONG_PTR graphicsToken;
static LRESULT CALLBACK editProc(HWND window,UINT msg,WPARAM wp,LPARAM lp,UINT_PTR,DWORD_PTR) {
  if(msg==WM_GETDLGCODE&&lp&&((MSG*)lp)->wParam==VK_RETURN)return DLGC_WANTMESSAGE;
  if(msg==WM_KEYDOWN&&wp==VK_RETURN){if(IsWindowEnabled(GetDlgItem(mainWindow,IDOK)))PostMessage(mainWindow,WM_COMMAND,IDOK,0);return 0;}
  return DefSubclassProc(window,msg,wp,lp);
}
static LRESULT CALLBACK buttonProc(HWND window,UINT msg,WPARAM wp,LPARAM lp,UINT_PTR,DWORD_PTR) {
  // Dialog focus/default-button handling must not replace the branded drawing style.
  if(msg==WM_STYLECHANGING&&wp==(WPARAM)GWL_STYLE){auto style=(STYLESTRUCT*)lp;style->styleNew=(style->styleNew&~BS_TYPEMASK)|BS_OWNERDRAW;}
  if(msg==WM_MOUSEMOVE&&!GetProp(window,L"hover")){SetProp(window,L"hover",(HANDLE)1);TRACKMOUSEEVENT event={sizeof(event),TME_LEAVE,window,0};TrackMouseEvent(&event);InvalidateRect(window,nullptr,TRUE);}
  if(msg==WM_MOUSELEAVE){RemoveProp(window,L"hover");InvalidateRect(window,nullptr,TRUE);}
  if(msg==WM_GETDLGCODE)return DLGC_BUTTON|((lp&&((MSG*)lp)->wParam==VK_RETURN)?DLGC_WANTMESSAGE:0)|(GetDlgCtrlID(window)==IDOK?DLGC_DEFPUSHBUTTON:DLGC_UNDEFPUSHBUTTON);
  if(msg==WM_KEYDOWN&&wp==VK_RETURN){SendMessage(window,BM_CLICK,0,0);return 0;}
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
static void move(HWND control,int x,int y,int w,int h) { SetWindowPos(control,nullptr,px(x),px(y),px(w),px(h),SWP_NOZORDER|SWP_NOACTIVATE); }
static void ownerButton(HWND button) { SetWindowTheme(button,L"",L"");SetWindowLongPtr(button,GWL_STYLE,(GetWindowLongPtr(button,GWL_STYLE)&~BS_TYPEMASK)|BS_OWNERDRAW);SendMessage(button,WM_SETFONT,(WPARAM)regular,TRUE);SetWindowSubclass(button,buttonProc,2,0); }
static void drawButton(DRAWITEMSTRUCT* item) {
  bool primary=GetDlgCtrlID(item->hwndItem)==IDOK,close=GetDlgCtrlID(item->hwndItem)==60001;
  bool disabled=(item->itemState&ODS_DISABLED)!=0,pressed=(item->itemState&ODS_SELECTED)!=0,hover=GetProp(item->hwndItem,L"hover")!=nullptr;
  RECT r=item->rcItem;FillRect(item->hDC,&r,white);SetBkMode(item->hDC,TRANSPARENT);
  if(primary||hover){HBRUSH fill=CreateSolidBrush(primary?(disabled?RGB(161,162,164):pressed||hover?RGB(57,58,60):RGB(23,24,26)):RGB(241,241,239));HGDIOBJ oldBrush=SelectObject(item->hDC,fill),oldPen=SelectObject(item->hDC,GetStockObject(NULL_PEN));RoundRect(item->hDC,r.left,r.top,r.right,r.bottom,px(10),px(10));SelectObject(item->hDC,oldBrush);SelectObject(item->hDC,oldPen);DeleteObject(fill);}
  SetTextColor(item->hDC,primary?RGB(255,255,255):disabled?RGB(180,181,183):close?RGB(164,166,167):RGB(115,117,121));
  wchar_t text[64];GetWindowText(item->hwndItem,text,64);HFONT old=(HFONT)SelectObject(item->hDC,regular);DrawText(item->hDC,text,-1,&r,DT_CENTER|DT_VCENTER|DT_SINGLELINE);SelectObject(item->hDC,old);
  if((item->itemState&ODS_FOCUS)&&!(item->itemState&ODS_NOFOCUSRECT)){InflateRect(&r,-px(3),-px(3));DrawFocusRect(item->hDC,&r);}
}
static LRESULT CALLBACK skinProc(HWND window,UINT msg,WPARAM wp,LPARAM lp,UINT_PTR,DWORD_PTR) {
  if(msg==WM_ERASEBKGND){paintField(window,(HDC)wp);return 1;}
  if(msg==WM_CTLCOLORSTATIC||msg==WM_CTLCOLOREDIT||msg==WM_CTLCOLORDLG){HDC dc=(HDC)wp;SetBkMode(dc,TRANSPARENT);int id=GetDlgCtrlID((HWND)lp);SetTextColor(dc,GetProp((HWND)lp,L"error")?RGB(166,52,41):id==60003?RGB(164,166,168):id==60002?RGB(23,24,26):RGB(90,92,95));return (LRESULT)white;}
  if(msg==WM_DRAWITEM){drawButton((DRAWITEMSTRUCT*)lp);return TRUE;}
  if(window==mainWindow&&msg==WM_COMMAND&&LOWORD(wp)==60001){SendMessage(window,WM_COMMAND,IDCANCEL,0);return 0;}
  if(window==mainWindow&&msg==WM_NCHITTEST){LRESULT hit=DefSubclassProc(window,msg,wp,lp);if(hit==HTCLIENT){POINT p={GET_X_LPARAM(lp),GET_Y_LPARAM(lp)};ScreenToClient(window,&p);if(p.y<px(64))return HTCAPTION;}return hit;}
  return DefSubclassProc(window,msg,wp,lp);
}
static HWND label(HWND parent,int id,const wchar_t* text,int x,int y,int w,int h,HFONT font) {
  HWND control=CreateWindow(L"STATIC",text,WS_CHILD|WS_VISIBLE|SS_NOPREFIX,x,y,w,h,parent,(HMENU)(INT_PTR)id,GetModuleHandle(nullptr),nullptr);move(control,x,y,w,h);SendMessage(control,WM_SETFONT,(WPARAM)font,TRUE);return control;
}
extern "C" void __stdcall Skin(HWND parent,HWND page,const wchar_t* version,int mode) {
  if(!mainWindow){mainWindow=parent;dpi=GetDpiForWindow(parent);white=CreateSolidBrush(RGB(255,255,255));
    regular=CreateFont(-px(11),0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,DEFAULT_PITCH,L"Microsoft YaHei UI");
    titleFont=CreateFont(-px(28),0,0,0,FW_MEDIUM,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,DEFAULT_PITCH,L"Segoe UI");
    mono=CreateFont(-px(11),0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,FIXED_PITCH,L"Consolas");versionFont=CreateFont(-px(9),0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,FIXED_PITCH,L"Consolas");makeField();
    RECT r;GetWindowRect(parent,&r);SetWindowLongPtr(parent,GWL_STYLE,WS_POPUP|WS_SYSMENU|WS_CLIPCHILDREN);SetWindowLongPtr(parent,GWL_EXSTYLE,WS_EX_APPWINDOW);
    SetWindowPos(parent,nullptr,(r.left+r.right-px(620))/2,(r.top+r.bottom-px(240))/2,px(620),px(240),SWP_NOZORDER|SWP_FRAMECHANGED);
    SetWindowRgn(parent,CreateRoundRectRgn(0,0,px(620)+1,px(240)+1,px(12),px(12)),TRUE);SetWindowSubclass(parent,skinProc,1,0);
    HWND close=CreateWindow(L"BUTTON",L"×",WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_OWNERDRAW,0,0,0,0,parent,(HMENU)60001,GetModuleHandle(nullptr),nullptr);move(close,584,5,30,28);ownerButton(close);
    label(parent,60003,version,32,196,160,16,versionFont);
  }
  // NSIS changes pages and button state; retain its normal keyboard/default actions.
  HWND next=GetDlgItem(parent,IDOK),cancel=GetDlgItem(parent,IDCANCEL);move(next,530,187,58,29);move(cancel,478,187,42,29);ownerButton(next);ownerButton(cancel);ShowWindow(GetDlgItem(parent,3),SW_HIDE);
  SetWindowText(cancel,L"取消");SendMessage(parent,DM_SETDEFID,IDOK,0);
  for(HWND child=GetWindow(parent,GW_CHILD);child;child=GetWindow(child,GW_HWNDNEXT)){int id=GetDlgCtrlID(child);if(child!=page&&child!=next&&child!=cancel&&id!=60001&&id!=60003)ShowWindow(child,SW_HIDE);}
  move(page,0,0,620,180);ShowWindow(page,SW_SHOW);SetWindowSubclass(page,skinProc,1,0);
  if(mode==0)SetProp(page,L"folder",(HANDLE)1);else RemoveProp(page,L"folder");
  label(page,60002,L"XwX Deck",32,88,175,42,titleFont);
  if(mode==2){ // NSIS's real extraction/registration progress, not a timer animation.
    HWND bar=GetDlgItem(page,1004),caption=GetDlgItem(page,1006);move(bar,225,119,363,4);move(caption,225,86,363,22);SendMessage(caption,WM_SETFONT,(WPARAM)regular,TRUE);ShowWindow(bar,SW_SHOW);ShowWindow(caption,SW_SHOW);SetWindowTheme(bar,L"",L"");SendMessage(bar,PBM_SETBARCOLOR,0,RGB(23,24,26));SendMessage(bar,PBM_SETBKCOLOR,0,RGB(240,240,238));
  }
  if(mode==1||mode==4){ShowWindow(cancel,SW_HIDE);EnableWindow(GetDlgItem(parent,60001),FALSE);}else if(mode==2)EnableWindow(GetDlgItem(parent,60001),FALSE);
  InvalidateRect(parent,nullptr,TRUE);InvalidateRect(page,nullptr,TRUE);
}
extern "C" void __stdcall Field(HWND window,int kind) {
  ShowWindow(window,SW_SHOW);
  SendMessage(window,WM_SETFONT,(WPARAM)regular,TRUE);
  if(kind==0)move(window,247,108,303,22);
  if(kind==1)move(window,558,104,36,28);
  if(kind==2)move(window,225,78,363,18);
  if(kind==3){move(window,225,140,363,34);SetProp(window,L"error",(HANDLE)1);}
  if(kind==4)move(window,225,78,363,22);
  if(kind==5)move(window,225,111,363,24);
  if(kind==6)move(window,225,106,363,44);
  // Remove theme edges only from the editable path. Keep genuine edit/button controls.
  if(kind==0){SetWindowTheme(window,L"",L"");SetWindowLongPtr(window,GWL_STYLE,GetWindowLongPtr(window,GWL_STYLE)&~WS_BORDER);SetWindowLongPtr(window,GWL_EXSTYLE,GetWindowLongPtr(window,GWL_EXSTYLE)&~WS_EX_CLIENTEDGE);SendMessage(window,WM_SETFONT,(WPARAM)mono,TRUE);SetWindowSubclass(window,editProc,3,0);SetWindowPos(window,nullptr,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER|SWP_FRAMECHANGED);}
  else if(kind==1)ownerButton(window);
}
