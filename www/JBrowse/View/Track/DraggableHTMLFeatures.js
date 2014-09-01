define( [
            'dojo/_base/declare',
            'dojo/_base/array',
            'JBrowse/View/Track/HTMLFeatures',
            'JBrowse/FeatureSelectionManager',
            'jquery',
            'jqueryui/draggable',
            'JBrowse/Util',
            'JBrowse/Model/SimpleFeature',
            'JBrowse/SequenceOntologyUtils'
        ],
        function (declare, array, HTMLFeatureTrack, FeatureSelectionManager, $, draggable, Util, SimpleFeature, SeqOnto) {

/*  Subclass of FeatureTrack that allows features to be selected,
    and dragged and dropped into the annotation track to create annotations.

    WARNING:
    for selection to work for features that cross block boundaries, z-index of feature style MUST be set, and must be > 0
    otherwise what happens is:
          feature div inherits z-order from parent, so same z-order as block
          so feature div pixels may extend into next block, but next block draws ON TOP OF IT (assuming next block added
          to parent after current block).  So events over part of feature div that isn't within it's parent block will never
          reach feature div but instead be triggered on next block
          This issue will be more obvious if blocks have background color set since then not only will selection not work but
          part of feature div that extends into next block won't even be visible, since next block background will render over it
 */

var debugFrame = false;

//var DraggableFeatureTrack = declare( HTMLFeatureTrack,
var draggableTrack = declare( HTMLFeatureTrack,

{
    // so is dragging
    dragging: false,

    _defaultConfig: function() {
        return Util.deepUpdate(
            dojo.clone( this.inherited(arguments) ),
            {
                events: {
                    // need to map click to a null-op, to override default JBrowse click behavior for click on features 
                    //     (JBrowse default is feature detail popup)
                    click:     function(event) {
                        // not quite a null-op, also need to suprress propagation of click recursively up through parent divs,
                        //    in order to stop default JBrowse behavior for click on tracks (which is to recenter view at click point)
                        event.stopPropagation();
                    }
                    // WebApollo can't set up mousedown --> onFeatureMouseDown() in config.events, 
                    //     because dojo.on used by JBrowse config-based event setup doesn't play nice with 
                    //     JQuery event retriggering via _mousedown() for feature drag bootstrapping
                    // also, JBrowse only sets these events for features, and WebApollo needs them to trigger for subfeatures as well
                    // , mousedown: dojo.hitch( this, 'onFeatureMouseDown' ),
                    // , dblclick:  dojo.hitch( this, 'onFeatureDoubleClick' )
                }
            }
        );
    },

    constructor: function( args ) {
        this.gview = this.browser.view;

        // DraggableFeatureTracks all share the same FeatureSelectionManager if
        // want subclasses to have different selection manager, call
        // this.setSelectionManager in subclass (after calling parent
        // constructor).
        this.setSelectionManager(this.browser.featSelectionManager);

        // CSS class for selected features
        // override if want subclass to have different CSS class for selected features
        this.selectionClass = "selected-feature";

        this.last_whitespace_mousedown_loc = null;
        this.last_whitespace_mouseup_time = new Date();  // dummy timestamp
        this.prev_selection = null;

        this.feature_context_menu = null;
        this.edge_matching_enabled = true;
    },


    loadSuccess: function(trackInfo) {
        /* if subclass indicates it has custom context menu, do not initialize default feature context menu */
        if (! this.has_custom_context_menu) {
            this.initFeatureContextMenu();
            this.initFeatureDialog();
        }
        this.inherited( arguments );
    },

    setSelectionManager: function(selman)  {
        if (this.selectionManager)  {
            this.selectionManager.removeListener(this);
        }
        this.selectionManager = selman;
        // FeatureSelectionManager listeners must implement
        //     selectionAdded() and selectionRemoved() response methods
        this.selectionManager.addListener(this);
        return selman;
    },

/**
 *   only called once, during track setup ???
 *
 *   doublclick in track whitespace is used by JBrowse for zoom
 *      but WebApollo/JBrowse uses single click in whitespace to clear selection
 *
 *   so this sets up mousedown/mouseup/doubleclick
 *      kludge to restore selection after a double click to whatever selection was before
 *      initiation of doubleclick (first mousedown/mouseup)
 *
 */
    setViewInfo: function(genomeView, numBlocks,
                          trackDiv, labelDiv,
                          widthPct, widthPx, scale) {
        this.inherited( arguments );

        var $div = $(this.div);
        var track = this;

        // this.scale = scale;  // scale is in pixels per base

        // setting up mousedown and mouseup handlers to enable click-in-whitespace to clear selection
        //    (without conflicting with JBrowse drag-in-whitespace to scroll)
        $div.bind('mousedown', function(event)  {
                      var target = event.target;
                      if (! (target.feature || target.subfeature))  {
                          track.last_whitespace_mousedown_loc = [ event.pageX, event.pageY ];
                      }
                  } );
        $div.bind('mouseup', function (event) {
                      var target = event.target;
                      if (! (target.feature || target.subfeature))  {  // event not on feature, so must be on whitespace
                          var xup = event.pageX;
                          var yup = event.pageY;
                          // if click in whitespace without dragging (no movement between mouse down and mouse up,
                          //    and no shift modifier,
                          //    then deselect all
                          var eventModifier = event.shiftKey || event.altKey || event.metaKey || event.ctrlKey;
                          if (track.last_whitespace_mousedown_loc &&
                              xup === track.last_whitespace_mousedown_loc[0] &&
                              yup === track.last_whitespace_mousedown_loc[1] &&
                              (! eventModifier ))  {
                                  var timestamp = new Date();
                                  var prev_timestamp = track.last_whitespace_mouseup_time;
                                  track.last_whitespace_mouseup_time = timestamp;
                                  // if less than half a second, probably a doubleclick (or triple or more click...)
                                  var probably_doubleclick = ((timestamp.getTime() - prev_timestamp.getTime()) < 500);
                                  if (probably_doubleclick)  {
                                      // don't record selection state, want to keep prev_selection set
                                      //    to selection prior to first mouseup of doubleclick
                                  }
                                  else {
                                      track.prev_selection = track.selectionManager.getSelection();
                                  }
                                  track.selectionManager.clearAllSelection();
                              }
                          else   {
                              track.prev_selection = null;
                          }
                      }
                      // regardless of what element it's over, mouseup clears out tracking of mouse down
                      track.last_whitespace_mousedown_loc = null;
                  });

                  // kludge to restore selection after a double click to
                  // whatever selection was before initiation of doubleclick
                  // (first mousedown/mouseup)
                  $div.bind('dblclick', function(event) {
                      var target = event.target;
                      // because of dblclick bound to features, will only bubble up to here on whitespace,
                      //   but doing feature check just to make sure
                      if (! (target.feature || target.subfeature))  {
                          if (track.prev_selection)  {
                              var plength = track.prev_selection.length;
                              // restore selection
                              for (var i = 0; i<plength; i++)  {
                                  track.selectionManager.addToSelection(track.prev_selection[i]);
                              }
                          }
                      }
                      track.prev_selection = null;
                  } );


        /* track click diagnostic (and example of how to add additional track mouse listener?)  */
        $div.bind("click", function(event) {
                      // console.log("track click, base position: " + track.gview.getGenomeCoord(event));
                      var target = event.target;
                      if (target.feature || target.subfeature)  {
                          event.stopPropagation();
                      }
                  } );

    },

    selectionAdded: function( rec, smanager) {
        var track = this;
        if( rec.track === track)  {
            var featdiv = track.getFeatDiv( rec.feature );
            if( featdiv )  {
                var jq_featdiv = $(featdiv);
                if (!jq_featdiv.hasClass(track.selectionClass))  {
                    jq_featdiv.addClass(track.selectionClass);
                }
            }
        }
    },

    selectionCleared: function(selected, smanager) {
        var track = this;
        var slength = selected.length;
        for (var i=0; i<slength; i++)  {
            var rec = selected[i];
            track.selectionRemoved( rec );
        }
    },

    selectionRemoved: function( rec, smanager)  {
        var track = this;
        if( rec.track === track )  {
            var featdiv = track.getFeatDiv( rec.feature );
            if( featdiv )  {
                var jq_featdiv = $(featdiv);
                if (jq_featdiv.hasClass(track.selectionClass))  {
                    jq_featdiv.removeClass(track.selectionClass);
                }

                if (jq_featdiv.hasClass("ui-draggable"))  {
                    jq_featdiv.draggable("destroy");
                }
                if (jq_featdiv.hasClass("ui-multidraggable"))  {
                    jq_featdiv.multidraggable("destroy");
                }
            }

        }
    },

    /**
     *  overriding renderFeature to add event handling for mouseover, mousedown, mouseup
     */
    renderFeature: function(feature, uniqueId, block, scale, labelScale, descriptionScale, 
                            containerStart, containerEnd) {
        var featdiv = this.inherited( arguments );
        if (featdiv)  {  // just in case featDiv doesn't actually get created
            var $featdiv = $(featdiv);
            $featdiv.on("mousedown", dojo.hitch( this, 'onFeatureMouseDown'));
            $featdiv.on("dblclick",  dojo.hitch( this, 'onFeatureDoubleClick'));
            if (this.feature_context_menu  && (! this.has_custom_context_menu)) {
                this.feature_context_menu.bindDomNode(featdiv);
            }

            // if renderClassName field exists in trackData.json for this track, then add a child
            //    div to the featdiv with class for CSS styling set to renderClassName value
            var rclass = this.config.style.renderClassName;
            if (rclass)  {
                var rendiv = document.createElement("div");
                dojo.addClass(rendiv, "feature-render");
                dojo.addClass(rendiv, rclass);
                //if (Util.is_ie6) rendiv.appendChild(document.createComment());
                featdiv.appendChild(rendiv);
            }
        }
        return featdiv;
    },

    renderSubfeature: function( feature, featDiv, subfeature,
                                displayStart, displayEnd, block )  {

        var subfeatdiv = this.inherited( arguments );
        if (subfeatdiv)  {  // just in case subFeatDiv doesn't actually get created
            var $subfeatdiv = $(subfeatdiv);
            // adding pointer to track for each subfeatdiv
            //   (could get this by DOM traversal, but shouldn't take much memory, and having it with each subfeatdiv is more convenient)
            subfeatdiv.track = this;
            subfeatdiv.subfeature = subfeature;
            $subfeatdiv.bind("mousedown", dojo.hitch( this, 'onFeatureMouseDown' ) );
            $subfeatdiv.bind("dblclick",  dojo.hitch( this, 'onFeatureDoubleClick') );
        }
        return subfeatdiv;
    },

    /*
     *  selection occurs on mouse down
     *  mouse-down on unselected feature -- deselect all & select feature
     *  mouse-down on selected feature -- no change to selection (but may start drag?)
     *  mouse-down on "empty" area -- deselect all
     *        (WARNING: this is preferred behavior, but conflicts with dblclick for zoom -- zoom would also deselect)
     *         therefore have mouse-click on empty area deselect all (no conflict with dblclick)
     *  shift-mouse-down on unselected feature -- add feature to selection
     *  shift-mouse-down on selected feature -- remove feature from selection
     *  shift-mouse-down on "empty" area -- no change to selection
     *
     *   "this" should be a featdiv or subfeatdiv
     */
    onFeatureMouseDown: function(event) {
        // event.stopPropagation();

        this.handleFeatureSelection(event);
        this.handleFeatureDragSetup(event);
    },

   handleFeatureSelection: function (event)  {
       var track = this;
       var feature_div = (event.currentTarget || event.srcElement);
       var feature = feature_div.feature || feature_div.subfeature;

       if (this.selectionManager.unselectableTypes[feature.get('type')]) {
           return;
       }

       var already_selected = this.selectionManager.isSelected({feature: feature, track: this});
       var parent_selected  = this.selectionManager.isSelected({feature: feature.parent(), track: this});

       if (event.shiftKey)  {
           if (already_selected) {
               this.selectionManager.removeFromSelection( { feature: feature, track: this });
           }
           else {
               // children are auto-deselected by selection manager when parent is selected
               this.selectionManager.addToSelection({feature: feature, track: this}, true);
           }
       }
       else  {
           if (parent_selected) {
               // Two options:
               // 1. drag transcript if user initiates drag
               // 2. select exon if user clicks
               $(feature_div).on('mousedown', function (e) {
                   $(feature_div).on('mouseup mousemove', function handler(e) {
                       if (e.type === 'mouseup') {
                           // user clicked on the exon
                           track.selectionManager.clearSelection();
                           track.selectionManager.addToSelection({track: track, feature: feature});
                           e.stopPropagation();
                       }
                       $(feature_div).off('mouseup mousemove', handler);
                   });
               });
           }
           else if (!already_selected)  {
               this.selectionManager.clearSelection();
               this.selectionManager.addToSelection({track: this, feature: feature});
               event.stopPropagation();
           }
       }

       // Stop event propogation if parent is not already selected so parent
       // feature doesn't react to mouse-click.
       if (!parent_selected)  {
           event.stopPropagation();
       }
    },

    /*
     * WARNING: Assumes one level (featdiv has feature) or two-level (featdiv
     * has feature, subdivs have subfeature) feature hierarchy.
     */
    handleFeatureDragSetup: function(event)  {
        var ftrack = this;
        var featdiv = (event.currentTarget || event.srcElement);
        var feat = featdiv.feature || featdiv.subfeature;
        var selected = this.selectionManager.isSelected({ feature: feat, track: ftrack });

        var valid_drop;
        /**
            *  ideally would only make $.draggable call once for each selected div
            *  but having problems with draggability disappearing from selected divs
            *       that $.draggable was already called on
            *  therefore whenever mousedown on a previously selected div also want to
            *       check that draggability and redo if missing
            */
        if (selected)  {
            var $featdiv = $(featdiv);
            if (! $featdiv.hasClass("ui-draggable"))  {

                var atrack = ftrack.browser.getEditTrack();
                if (! atrack) { atrack = ftrack.browser.getSequenceTrack();  }
                var fblock = ftrack.getBlock(featdiv);

                // append drag ghost to featdiv block's equivalent block in annotation track if present, 
                //     else  append to equivalent block in sequence track if present, 
                //     else append to featdiv's block 
                var ablock = (atrack ? atrack.getEquivalentBlock(fblock) : fblock);
                var multifeature_draggable_helper = function () {
                    // var $featdiv_copy = $featdiv.clone();
                    var $pfeatdiv;
                    // get top-level feature (assumes one or two-level feature hierarchy)
                    if (featdiv.subfeature) {
                        $pfeatdiv = $(featdiv.parentNode);
                    }
                    else  {
                        $pfeatdiv = $(featdiv);
                    }
                    var $holder = $pfeatdiv.clone();
                    $holder.removeClass();
                    // just want the shell of the top-level feature, so remove children
                    //      (selected children will be added back in below)
                    $holder.empty();
                    $holder.addClass("multifeature-draggable-helper");
                    var holder = $holder[0];
                    // var featdiv_copy = $featdiv_copy[0];

                    var foffset = $pfeatdiv.offset();
                    var fheight = $pfeatdiv.height();
                    var fwidth = $pfeatdiv.width();
                    var ftop = foffset.top;
                    var fleft = foffset.left;
                    var selection = ftrack.selectionManager.getSelection();
                    var selength = selection.length;
                    for (var i=0; i<selength; i++)  {
                        var srec = selection[i];
                        var strack = srec.track;
                        var sfeat = srec.feature;
                        var sfeatdiv = strack.getFeatDiv( sfeat );
                        if (sfeatdiv)  {
                            var $sfeatdiv = $(sfeatdiv);
                            var $divclone = $sfeatdiv.clone();
                            var soffset = $sfeatdiv.offset();
                            var sheight = $sfeatdiv.height();
                            var swidth =$sfeatdiv.width();
                            var seltop = soffset.top;
                            var sleft = soffset.left;
                            $divclone.width(swidth);
                            $divclone.height(sheight);
                            var delta_top = seltop - ftop;
                            var delta_left = sleft - fleft;
                            //  setting left and top by pixel, based on delta relative to moused-on feature
                            //    tried using $divclone.position( { ...., "offset": delta_left + " " + delta_top } );,
                            //    but position() not working for negative deltas? (ends up using absolute value)
                            //    so doing more directly with "left and "top" css calls
                            $divclone.css("left", delta_left);
                            $divclone.css("top", delta_top);
                            var divclone = $divclone[0];
                            holder.appendChild(divclone);
                        }
                    }
                    return holder;
                }

                $featdiv.draggable({ // draggable() adds "ui-draggable" class to div
                        zIndex:  200,
                        helper:  multifeature_draggable_helper,
                        appendTo:ablock.domNode,
                        opacity: 0.5,
                        axis:    'y',
                        revert:  function (valid) {
                            valid_drop = !!valid;
                            return;
                        },
                        stop: function (event, ui) {
                            if (valid_drop) {
                                ftrack.selectionManager.clearAllSelection();
                            }
                        }
                });
                $featdiv.data("ui-draggable")._mouseDown(event);
            }
        }
    },

    /* given a feature or subfeature, return block that rendered it */
    getBlock: function( featdiv ) {
        var fdiv = featdiv;
        while (fdiv.feature || fdiv.subfeature) {
            if (fdiv.parentNode.block) { return fdiv.parentNode.block; }
            fdiv = fdiv.parentNode;
        }
        return null;  // should never get here...
    },

    getEquivalentBlock: function ( block ) {
        var startBase = block.startBase;
        var endBase = block.endBase;
        for (var i=this.firstAttached; i<=this.lastAttached; i++)  {
            var testBlock = this.blocks[i];
            if (testBlock.startBase == startBase && testBlock.endBase == endBase) {
                return testBlock;
            }
        }
        return null;
    },

    onFeatureDoubleClick: function( event )  {
        var ftrack = this;
        var selman = ftrack.selectionManager;
        // prevent event bubbling up to genome view and triggering zoom
        event.stopPropagation();
        var featdiv = (event.currentTarget || event.srcElement);

        // only take action on double-click for subfeatures
        //  (but stop propagation for both features and subfeatures)
        // GAH TODO:  make this work for feature hierarchies > 2 levels deep
        var subfeat = featdiv.subfeature;
       // if (subfeat && (! unselectableTypes[subfeat.get('type')]))  {  // only allow double-click parent selection for selectable features
        if( subfeat && selman.isSelected({ feature: subfeat, track: ftrack }) ) {  // only allow double-click of child for parent selection if child is already selected
            var parent = subfeat.parent();
            // select parent feature
            // children (including subfeat double-clicked one) are auto-deselected in FeatureSelectionManager if parent is selected
            if( parent ) { selman.addToSelection({ feature: parent, track: ftrack }); }
        }
    },


    /**
     *  returns first feature or subfeature div (including itself)
     *  found when crawling towards root from branch in
     *  feature/subfeature/descendants div hierachy
     */
    getLowestFeatureDiv: function(elem)  {
        while (!elem.feature && !elem.subfeature)  {
            elem = elem.parentNode;
            if (elem === document)  {return null;}
        }
        return elem;
    },


    /**
     * Near as I can tell, track.showRange is called every time the
     * appearance of the track changes in a way that would cause
     * feature divs to be added or deleted (or moved? -- not sure,
     * feature moves may also happen elsewhere?)  So overriding
     * showRange here to try and map selected features to selected
     * divs and make sure the divs have selection style set
     */
    showRange: function( first, last, startBase, bpPerBlock, scale,
                         containerStart, containerEnd ) {
        this.inherited( arguments );

        //    console.log("called DraggableFeatureTrack.showRange(), block range: " +
        //          this.firstAttached +  "--" + this.lastAttached + ",  " + (this.lastAttached - this.firstAttached));
        // redo selection styles for divs in case any divs for selected features were changed/added/deleted
        var srecs = this.selectionManager.getSelection();
        for (var sin in srecs)  {
            // only look for selected features in this track --
            // otherwise will be redoing (sfeats.length * tracks.length) times instead of sfeats.length times,
            // because showRange is getting called for each track
            var srec = srecs[sin];
            if (srec.track === this)  {
                // some or all feature divs are usually recreated in a showRange call
                //  therefore calling track.selectionAdded() to retrigger setting of selected-feature CSS style, etc. on new feat divs
                this.selectionAdded(srec);
            }
        }
    },

    /* bypassing HTMLFeatures floating of arrows to keep them in view, too buggy for now */
    updateFeatureArrowPositions: function( coords ) {
        return;
    },

    /**
    *  for the input mouse event, returns genome position under mouse IN 0-BASED INTERBASE COORDINATES
    *  WARNING:
    *  returns genome coord in 0-based interbase (which is how internal data structure represent coords),
    *       instead of 1-based interbase (which is how UI displays coordinates)
    *  if need display coordinates, use getUiGenomeCoord() directly instead
    *
    *  otherwise same capability and assumptions as getUiGenomeCoord():
    *  event can be on GenomeView.elem or any descendant DOM elements (track, block, feature divs, etc.)
    *  assumes:
    *      event is a mouse event (plain Javascript event or JQuery event)
    *      elem is a DOM element OR JQuery wrapped set (in which case result is based on first elem in result set)
    *      elem is displayed  (see JQuery.offset() docs)
    *      no border/margin/padding set on the doc <body> element  (see JQuery.offset() docs)
    *      if in IE<9, either page is not scrollable (in the HTML page sense) OR event is JQuery event
    *         (currently JBrowse index.html page is not scrollable (JBrowse internal scrolling is NOT same as HTML page scrolling))
    *
    */
    getGenomeCoord: function(mouseEvent)  {
        return Math.floor(this.gview.absXtoBp(mouseEvent.pageX));
        // return this.getUiGenomeCoord(mouseEvent) - 1;
    }

});

return draggableTrack;
});

 /*
   Copyright (c) 2010-2011 Berkeley Bioinformatics Open-source Projects & Lawrence Berkeley National Labs

   This package and its accompanying libraries are free software; you can
   redistribute it and/or modify it under the terms of the LGPL (either
   version 2.1, or at your option, any later version) or the Artistic
   License 2.0.  Refer to LICENSE for the full license text.
*/
