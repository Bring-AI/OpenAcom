using System;
using System.ComponentModel;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Threading.Tasks;

namespace OpenAcom.Desktop
{
    internal sealed class SessionGroupLabel
    {
        public string Key { get; private set; }
        public string Title { get; private set; }
        public string Description { get; private set; }
        public SessionGroupLabel(string key,string title,string description){Key=key;Title=title;Description=description;}
        public override bool Equals(object value){var other=value as SessionGroupLabel;return other!=null && StringComparer.Ordinal.Equals(Key,other.Key);}
        public override int GetHashCode(){return StringComparer.Ordinal.GetHashCode(Key);}
        public override string ToString(){return Title;}
    }
    internal sealed partial class ModernShell
    {
        private bool restoringSessionView;
        private int sessionReadRevision;
        private string cachedTranscriptId, cachedTranscript, cachedTranscriptState;
        private string sessionViewSignature;
        private System.Threading.Tasks.Task sessionPreferenceWrite=System.Threading.Tasks.Task.FromResult(0);
        private string SessionViewMode {get{return Convert.ToString(((ComboBoxItem)Find<ComboBox>("SessionViewMode").SelectedItem).Tag);}}
        private void InitializeSessionViews()
        {
            Find<ComboBox>("SessionViewMode").SelectionChanged+=async delegate {
                ApplySessionView();preferences["sessionView"]=SessionViewMode;
                if(restoringSessionView||options.UiSmoke)return;
                try{var req=Request("preferences.sessionView");req["mode"]=SessionViewMode;await WriteDesktopPreferences(req);}
                catch(Exception e){if(!closed)Status("显示方式已切换，但未保存："+Redact.Scrub(e.Message));}
            };
            Find<ListBox>("SessionsList").SelectionChanged+=async delegate {await LoadSelectedTranscript(false);};
            Find<Button>("SendSessionButton").Click+=delegate {var row=Find<ListBox>("SessionsList").SelectedItem as DesktopSession;if(row!=null){OpenCompose();Find<TextBox>("Recipient").Text=row.Id;}};
            Find<Button>("CopySessionAddress").Click+=delegate {var row=Find<ListBox>("SessionsList").SelectedItem as DesktopSession;if(row!=null){Clipboard.SetText(row.Id);Status("会话地址已复制。");}};
            ApplySessionView();
        }
        private bool SelectedSessionIs(string id,int revision)
        {var current=Find<ListBox>("SessionsList").SelectedItem as DesktopSession;return !closed && revision==sessionReadRevision && current!=null && current.Id==id;}
        private async Task LoadSelectedTranscript(bool force)
        {
            int revision=++sessionReadRevision;
            var row=Find<ListBox>("SessionsList").SelectedItem as DesktopSession;
            Find<Button>("SendSessionButton").IsEnabled=row!=null;Find<Button>("CopySessionAddress").IsEnabled=row!=null;
            bool readable=row!=null && !row.Id.StartsWith("node:");Find<Button>("ReadSessionButton").IsEnabled=readable;
            if(row==null){Find<TextBlock>("SessionDetailTitle").Text="选择一个会话";Find<TextBlock>("SessionDetailProject").Text="从左侧列表选择后，在这里查看内容和操作。";Find<TextBox>("SessionDetailAddress").Clear();Find<TextBox>("SessionTranscript").Text="点击左侧的会话名称即可查看。";Find<TextBlock>("SessionReadState").Text="尚未选择";return;}
            Find<TextBlock>("SessionDetailTitle").Text=row.DisplayTitle;
            Find<TextBlock>("SessionDetailProject").Text=row.AgentLabel+" · "+row.ProjectCaption+(string.IsNullOrEmpty(row.ProjectDescription)?"":"\n"+row.ProjectDescription);
            Find<TextBox>("SessionDetailAddress").Text=row.Id;
            if(!readable){Find<TextBox>("SessionTranscript").Text="该远端目标尚未提供会话内容读取接口。\n\n可以向它发送消息，或在分布式控制中查看投递状态。";Find<TextBlock>("SessionReadState").Text="远端目标";return;}
            if(!force && cachedTranscriptId==row.Id){Find<TextBox>("SessionTranscript").Text=cachedTranscript;Find<TextBlock>("SessionReadState").Text=cachedTranscriptState;return;}
            int last;if(!int.TryParse(Find<TextBox>("SessionReadLast").Text,out last)||last<1||last>100){Find<TextBlock>("SessionReadState").Text="轮数应为 1–100";Find<TextBox>("SessionTranscript").Text="请修改按钮右侧的读取轮数，再点击刷新内容。";return;}
            Find<TextBlock>("SessionReadState").Text="读取中…";Find<TextBox>("SessionTranscript").Text="正在读取会话内容…";
            try {
                if(!force && !options.UiSmoke)await Task.Delay(120);
                if(!SelectedSessionIs(row.Id,revision))return;
                string content;
                if(options.UiSmoke)content="（界面测试数据）\n\n[user]\n请检查接口与类型声明，并整理测试结果。\n\n[assistant]\n正在检查「"+row.DisplayTitle+"」。\n\n这里展示选中会话的内容。可以刷新内容、复制地址，或向会话发送新消息。";
                else {var req=Request("session.read");req["address"]=row.Id;req["last"]=last;var result=await Execute(req);content=J.S(result,"text");}
                if(!SelectedSessionIs(row.Id,revision))return;
                cachedTranscriptId=row.Id;cachedTranscript=string.IsNullOrEmpty(content)?"该会话暂无可读取的内容。":content;cachedTranscriptState="已刷新 "+DateTime.Now.ToString("HH:mm:ss");
                Find<TextBox>("SessionTranscript").Text=cachedTranscript;Find<TextBlock>("SessionReadState").Text=cachedTranscriptState;
            }catch(Exception e){if(SelectedSessionIs(row.Id,revision)){Find<TextBox>("SessionTranscript").Text="无法读取会话：\n"+Redact.Scrub(e.Message);Find<TextBlock>("SessionReadState").Text="读取失败，可重试";}}
        }
        private System.Threading.Tasks.Task WriteDesktopPreferences(System.Collections.Generic.Dictionary<string,object> request)
        {
            // Serialize preference writes so quick view switches cannot save out of order.
            sessionPreferenceWrite=sessionPreferenceWrite.ContinueWith(previous=>Execute(request)).Unwrap();
            return sessionPreferenceWrite;
        }
        private void RestoreSessionView(string mode)
        {
            restoringSessionView=true;
            try{Find<ComboBox>("SessionViewMode").SelectedIndex=mode=="agent"?1:0;ApplySessionView();}
            finally{restoringSessionView=false;}
        }
        private void ApplySessionView()
        {
            var list=Find<ListBox>("SessionsList");
            string signature=SessionViewMode+Json.Write(sessions.Select(s=>(object)new System.Collections.Generic.List<object>{s.Id,s.Title,s.Agent,s.Workspace,s.ProjectKey,s.ProjectLabel,s.ProjectDescription,s.Order}).ToList());
            if(signature==sessionViewSignature)return;
            sessionViewSignature=signature;var selected=list.SelectedItem as DesktopSession;
            // Use a separate view so grouping never affects the recipient picker or dashboard.
            var view=new ListCollectionView(sessions);
            if(SessionViewMode=="project"){
                view.SortDescriptions.Add(new SortDescription("ProjectSort",ListSortDirection.Ascending));
                view.GroupDescriptions.Add(new PropertyGroupDescription("ProjectGroup"));
            }
            view.SortDescriptions.Add(new SortDescription("AgentSort",ListSortDirection.Ascending));
            view.SortDescriptions.Add(new SortDescription("Order",ListSortDirection.Ascending));
            view.GroupDescriptions.Add(new PropertyGroupDescription("AgentGroup"));
            list.GroupStyle.Clear();
            if(SessionViewMode=="project")list.GroupStyle.Add((GroupStyle)window.Resources["ProjectSessionGroups"]);
            list.GroupStyle.Add((GroupStyle)window.Resources["AgentSessionGroups"]);
            list.ItemsSource=view;
            if(selected!=null)list.SelectedItem=sessions.FirstOrDefault(row=>row.Id==selected.Id);
            Find<TextBlock>("SessionsEmpty").Visibility=sessions.Count==0?Visibility.Visible:Visibility.Collapsed;
            Find<TextBlock>("SessionViewSummary").Text=sessions.Count+" 个会话 · "+(SessionViewMode=="project"?sessions.Select(s=>s.ProjectGroup.Key).Distinct().Count()+" 个项目分组":sessions.Select(s=>s.Agent).Distinct().Count()+" 种 Agent 类型");
        }
    }
}
